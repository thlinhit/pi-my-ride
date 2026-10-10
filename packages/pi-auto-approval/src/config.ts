import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type RuleLevel = "guarded" | "convention";

/** A validated, compiled rule. */
export interface Rule {
  readonly pattern: RegExp; // compiled up front; never carries g or y flags
  readonly level: RuleLevel;
  readonly label: string; // human label shown in confirm / block reason
  readonly message?: string; // required for convention; allowed but unused for guarded
  readonly group?: string; // trusted-ops group; used only for guarded
}

export interface ConfigUi {
  readonly status: boolean;
}

export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "low";
export const REVIEW_TIMEOUT_DEFAULT_MS = 30_000;
export const REVIEW_TIMEOUT_MIN_MS = 1_000;
export const REVIEW_TIMEOUT_MAX_MS = 300_000;

export interface ReviewerConfig {
  readonly model?: { readonly provider: string; readonly id: string }; // undefined => active model
  readonly reasoningEffort: ReasoningEffort;
  readonly timeoutMs: number;
  readonly extraInstructions?: string; // resolved text (inline or file contents), non-blank when present
}

export const DEFAULT_REVIEWER: ReviewerConfig = { reasoningEffort: DEFAULT_REASONING_EFFORT, timeoutMs: REVIEW_TIMEOUT_DEFAULT_MS };

export type ConfigResult =
  | {
      readonly ok: true;
      readonly rules: readonly Rule[];
      readonly source: string | null;
      readonly ui: ConfigUi;
      readonly guardian: boolean;
      readonly reviewer: ReviewerConfig;
    }
  | { readonly ok: false; readonly error: string };

export const CONFIG_FILENAME = "auto-permissions.json";
export const TRUSTED_FILENAME = "trusted-ops";

const ALLOWED_FLAGS = "dimsuv";
const LEVELS: readonly string[] = ["guarded", "convention"];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

function parseFlags(flags: unknown, where: string): Parsed<string> {
  if (flags === undefined) return { ok: true, value: "" };
  if (typeof flags !== "string") return fail(`${where}: flags must be a string`);
  if (/[gy]/.test(flags)) return fail(`${where}: flags must not include g or y (stateful matching)`);
  if ([...flags].some((f) => !ALLOWED_FLAGS.includes(f))) return fail(`${where}: flags contain an unsupported character`);
  return { ok: true, value: flags };
}

function compilePattern(source: string, flags: string, where: string): Parsed<RegExp> {
  try {
    return { ok: true, value: new RegExp(source, flags) };
  } catch (err) {
    return fail(`${where}: invalid regex (${(err as Error).message})`);
  }
}

function parseRule(entry: unknown, where: string): Parsed<Rule> {
  if (!isObject(entry)) return fail(`${where} must be an object`);

  if (!isNonBlank(entry.pattern)) return fail(`${where}: pattern must be a non-empty string`);
  if (!isNonBlank(entry.label)) return fail(`${where}: label must be a non-empty string`);
  if (typeof entry.level !== "string" || !LEVELS.includes(entry.level)) {
    return fail(`${where}: level must be "guarded" or "convention"`);
  }

  const flags = parseFlags(entry.flags, where);
  if (!flags.ok) return flags;
  const pattern = compilePattern(entry.pattern, flags.value, where);
  if (!pattern.ok) return pattern;

  if (entry.message !== undefined && !isNonBlank(entry.message)) return fail(`${where}: message must be a non-empty string`);
  if (entry.level === "convention" && entry.message === undefined) return fail(`${where}: convention rules require a message`);
  if (entry.group !== undefined && !isNonBlank(entry.group)) return fail(`${where}: group must be a non-empty string`);

  return {
    ok: true,
    value: {
      pattern: pattern.value,
      level: entry.level as RuleLevel,
      label: entry.label,
      message: entry.message as string | undefined,
      group: entry.group as string | undefined,
    },
  };
}

function parseUi(ui: unknown, source: string): Parsed<ConfigUi> {
  if (ui === undefined) return { ok: true, value: { status: true } };
  if (!isObject(ui)) return fail(`${source}: ui must be an object`);
  if (ui.status === undefined) return { ok: true, value: { status: true } };
  if (typeof ui.status !== "boolean") return fail(`${source}: ui.status must be a boolean`);
  return { ok: true, value: { status: ui.status } };
}

function parseGuardian(value: unknown, source: string): Parsed<boolean> {
  if (value === undefined || value === "on") return { ok: true, value: true };
  if (value === "off") return { ok: true, value: false };
  return fail(`${source}: guardian must be "on" or "off"`);
}

function parseReviewer(raw: unknown, source: string, baseDir: string): Parsed<ReviewerConfig> {
  if (raw === undefined) return { ok: true, value: DEFAULT_REVIEWER };
  if (!isObject(raw)) return fail(`${source}: reviewer must be an object`);

  if ((raw.provider === undefined) !== (raw.model === undefined)) {
    return fail(`${source}: reviewer.provider and reviewer.model must be set together`);
  }
  if (raw.provider !== undefined && (!isNonBlank(raw.provider) || !isNonBlank(raw.model))) {
    return fail(`${source}: reviewer.provider and reviewer.model must be non-empty strings`);
  }

  let reasoningEffort: ReasoningEffort = DEFAULT_REASONING_EFFORT;
  if (raw.reasoningEffort !== undefined) {
    if (!REASONING_EFFORTS.includes(raw.reasoningEffort as ReasoningEffort)) {
      return fail(`${source}: reviewer.reasoningEffort must be one of ${REASONING_EFFORTS.join(", ")}`);
    }
    reasoningEffort = raw.reasoningEffort as ReasoningEffort;
  }

  let timeoutMs = REVIEW_TIMEOUT_DEFAULT_MS;
  if (raw.timeoutMs !== undefined) {
    const t = raw.timeoutMs;
    if (typeof t !== "number" || !Number.isInteger(t) || t < REVIEW_TIMEOUT_MIN_MS || t > REVIEW_TIMEOUT_MAX_MS) {
      return fail(`${source}: reviewer.timeoutMs must be an integer from ${REVIEW_TIMEOUT_MIN_MS} to ${REVIEW_TIMEOUT_MAX_MS}`);
    }
    timeoutMs = t;
  }

  if (raw.extraInstructions !== undefined && raw.extraInstructionsFile !== undefined) {
    return fail(`${source}: reviewer.extraInstructions and reviewer.extraInstructionsFile are mutually exclusive`);
  }
  let extraInstructions: string | undefined;
  if (raw.extraInstructions !== undefined) {
    if (!isNonBlank(raw.extraInstructions)) return fail(`${source}: reviewer.extraInstructions must be a non-empty string`);
    extraInstructions = raw.extraInstructions;
  } else if (raw.extraInstructionsFile !== undefined) {
    if (!isNonBlank(raw.extraInstructionsFile)) return fail(`${source}: reviewer.extraInstructionsFile must be a non-empty string`);
    const path = resolve(baseDir, raw.extraInstructionsFile);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return fail(`${source}: reviewer.extraInstructionsFile cannot be read (${path})`);
    }
    if (text.trim() === "") return fail(`${source}: reviewer.extraInstructionsFile is empty (${path})`);
    extraInstructions = text;
  }

  return {
    ok: true,
    value: {
      ...(raw.provider !== undefined ? { model: { provider: raw.provider as string, id: raw.model as string } } : {}),
      reasoningEffort,
      timeoutMs,
      ...(extraInstructions !== undefined ? { extraInstructions } : {}),
    },
  };
}

/**
 * Validates parsed JSON and compiles regexes. Never throws; returns { ok:false } instead.
 * Sync-reads `reviewer.extraInstructionsFile` (relative to baseDir) when set; the only I/O here.
 */
export function parseConfig(raw: unknown, source: string, baseDir = "."): ConfigResult {
  if (!isObject(raw)) return fail(`${source}: root must be an object`);
  if (!Array.isArray(raw.rules)) return fail(`${source}: rules must be an array`);

  const rules: Rule[] = [];
  for (let i = 0; i < raw.rules.length; i++) {
    const rule = parseRule(raw.rules[i], `${source}: rules[${i}]`);
    if (!rule.ok) return rule;
    rules.push(rule.value);
  }

  const ui = parseUi(raw.ui, source);
  if (!ui.ok) return ui;

  const guardian = parseGuardian(raw.guardian, source);
  if (!guardian.ok) return guardian;

  const reviewer = parseReviewer(raw.reviewer, source, baseDir);
  if (!reviewer.ok) return reviewer;

  return { ok: true, rules, source, ui: ui.value, guardian: guardian.value, reviewer: reviewer.value };
}

/**
 * Sync fs. Looks for `<cwd>/.pi/auto-permissions.json`, else `<globalDir>/auto-permissions.json`.
 * No file found -> { ok:true, rules:[], source:null }.
 * Only ENOENT permits trying the next candidate; any other read error blocks.
 * Invalid JSON / schema -> { ok:false, error }. Never throws.
 */
export function loadConfig(cwd: string, globalDir: string): ConfigResult {
  const candidates = [join(cwd, ".pi", CONFIG_FILENAME), join(globalDir, CONFIG_FILENAME)];

  for (const path of candidates) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      return { ok: false, error: `${path}: cannot read config (${code ?? "unknown error"})` };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      return { ok: false, error: `${path}: invalid JSON (${(err as Error).message})` };
    }
    return parseConfig(raw, path, dirname(path));
  }

  return {
    ok: true,
    rules: [],
    source: null,
    ui: { status: true },
    guardian: true,
    reviewer: DEFAULT_REVIEWER,
  };
}

/** Reads `<cwd>/.pi/trusted-ops`. Lines trimmed, blanks dropped, no comment syntax. Any read error (incl. ENOENT) => empty set. Never throws. Sync, read per call. */
export function loadTrustedGroups(cwd: string): ReadonlySet<string> {
  let text: string;
  try {
    text = readFileSync(join(cwd, ".pi", TRUSTED_FILENAME), "utf8");
  } catch {
    return new Set();
  }
  return new Set(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}
