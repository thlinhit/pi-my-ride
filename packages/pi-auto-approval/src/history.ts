import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface HistoryEntry {
  readonly tool: string;
  readonly command: string;
  readonly decision: "approved" | "blocked";
}

export type HistoryResult = { readonly ok: true } | { readonly ok: false; readonly error: string };
export const HISTORY_RELATIVE_PATH = join(".pi", "pi-auto-approval", "history.jsonl");

const REDACTED = "[REDACTED]";
const patterns = [
  /((?:Authorization\s*:\s*)|(?:Bearer\s+))[^\r\n;&|]+/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s]+/gi,
  /--(?:password|token|secret|api-key)(?:=|\s+)/gi,
];

function findValueEnd(
  text: string,
  start: number,
  initialQuote?: string,
  stopAtWhitespace = false,
): { end: number; closedInitialQuote: boolean; quote: string | undefined } {
  let quote = initialQuote;
  let closedInitialQuote = false;
  let i = start;
  for (; i < text.length; ) {
    const char = text[i]!;
    if (quote === "'" && char === "'") {
      if (initialQuote === quote) closedInitialQuote = true;
      quote = undefined;
      i++;
    } else if (quote === '"' && char === "\\") {
      i += 2;
    } else if (quote && char === quote) {
      if (initialQuote === quote) closedInitialQuote = true;
      quote = undefined;
      i++;
    } else if (!quote && char === "\\") {
      i += 2;
    } else if (!quote && (char === "'" || char === '"')) {
      quote = char;
      i++;
    } else if (!quote && /[\r\n;&|]/.test(char)) {
      break;
    } else if (!quote && stopAtWhitespace && /\s/.test(char)) {
      break;
    } else if (
      !quote &&
      i > start &&
      /\s/.test(char) &&
      /^[A-Za-z_][A-Za-z0-9_-]*\s*=/.test(text.slice(i).trimStart())
    ) {
      break;
    } else {
      i++;
    }
  }
  return { end: i, closedInitialQuote, quote };
}

function redactCliOptions(text: string): string {
  const spans: Array<{ start: number; end: number; quote?: string; closingQuote?: string }> = [];
  for (const match of text.matchAll(patterns[7]!)) {
    const start = match.index! + match[0].length;
    if (spans.some((span) => match.index! >= span.start && match.index! < span.end)) continue;
    const quote = text[start] === "'" || text[start] === '"' ? text[start] : undefined;
    const span = findValueEnd(text, start, undefined, quote !== undefined);
    spans.push({ start, end: span.end, quote, closingQuote: span.closedInitialQuote ? quote : undefined });
  }
  let result = text;
  for (const { start, end, quote, closingQuote } of spans.reverse()) {
    result = `${result.slice(0, start)}${quote ? `${quote}${REDACTED}${quote}` : `${REDACTED}${closingQuote ?? ""}`}${result.slice(end)}`;
  }
  return result;
}

function redactSensitiveAssignments(text: string): string {
  const spans: Array<{ start: number; end: number; quote?: string; closingQuote?: string }> = [];
  let quote: string | undefined;
  let escaped = false;

  for (let i = 0; i < text.length; ) {
    if (quote && escaped) {
      escaped = false;
      i++;
      continue;
    }
    if (quote === '"' && text[i] === "\\") {
      escaped = true;
      i++;
      continue;
    }
    if (quote && text[i] === quote) {
      quote = undefined;
      i++;
      continue;
    }
    if (!quote && text[i] === "\\") {
      i += 2;
      continue;
    }
    if (!quote && (text[i] === "'" || text[i] === '"')) {
      quote = text[i];
      i++;
      continue;
    }

    const previous = text[i - 1];
    const name = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(text.slice(i))?.[0];
    if (name && (!previous || !/[A-Za-z0-9_-]/.test(previous))) {
      let equals = i + name.length;
      while (text[equals] === " " || text[equals] === "\t") equals++;
      if (text[equals] === "=") {
        let start = equals + 1;
        while (text[start] === " " || text[start] === "\t") start++;
        if (/(?:secret|token|password|passwd|api[_-]?key|credential)/i.test(name)) {
          const valueQuote = !quote && (text[start] === "'" || text[start] === '"') ? text[start] : undefined;
          const span = findValueEnd(text, start, quote, quote !== undefined || valueQuote !== undefined);
          spans.push({
            start,
            end: span.end,
            quote: valueQuote,
            closingQuote: span.closedInitialQuote ? quote : undefined,
          });
          i = span.end;
          quote = span.quote;
          continue;
        }
      }
    }

    if (!quote && (text[i] === "'" || text[i] === '"')) quote = text[i];
    i++;
  }

  let result = text;
  for (const { start, end, quote, closingQuote } of spans.reverse()) {
    result = `${result.slice(0, start)}${quote ? `${quote}${REDACTED}${quote}` : `${REDACTED}${closingQuote ?? ""}`}${result.slice(end)}`;
  }
  return result;
}

export function redactSecrets(text: string): string {
  let result = redactSensitiveAssignments(text);
  result = redactCliOptions(result);
  result = result.replace(patterns[0]!, (_match, prefix: string) => `${prefix}${REDACTED}`);
  for (const pattern of patterns.slice(1, 7)) result = result.replace(pattern, REDACTED);
  return result;
}

export function recordHistory(
  cwd: string,
  entry: HistoryEntry,
  deps: { redact?: (text: string) => string; now?: () => Date } = {},
): HistoryResult {
  let command: string;
  try {
    command = (deps.redact ?? redactSecrets)(entry.command);
  } catch {
    return { ok: false, error: "History redaction failed" };
  }

  try {
    const directory = join(cwd, ".pi", "pi-auto-approval");
    mkdirSync(directory, { recursive: true });
    appendFileSync(
      join(directory, "history.jsonl"),
      `${JSON.stringify({
        time: (deps.now ?? (() => new Date()))().toISOString(),
        tool: entry.tool,
        command,
        decision: entry.decision,
      })}\n`,
    );
    return { ok: true };
  } catch {
    return { ok: false, error: "History save failed" };
  }
}
