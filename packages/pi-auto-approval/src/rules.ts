import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuleLevel } from "./config.ts";
import { foldPath, resolvePathForPolicy } from "./paths.ts";

export interface PermissionRule {
  readonly tool: string;
  readonly specifier?: string;
  readonly level: RuleLevel;
  readonly label: string;
  readonly source: string;
  readonly scope: "global" | "project";
}
export interface ToolCall {
  readonly toolName: string;
  readonly input: unknown;
}
export type RuleParse = { ok: true; value: PermissionRule } | { ok: false; error: string };

const BUILTINS = new Map(
  ["bash", "read", "edit", "write", "grep", "find", "ls", "powershell"].map((name) => [name, name]),
);
const SHELL_SEGMENT_DELIMITER = /[;&|\r\n`()<>]/;
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePermissionRule(
  raw: string,
  level: RuleLevel,
  source: string,
  scope: "global" | "project",
  where: string,
): RuleParse {
  const value = raw.trim();
  const fail = (message: string): RuleParse => ({ ok: false, error: `${where}: ${message}` });
  if (!value) return fail("rule must be a non-empty string");
  const open = value.indexOf("(");
  const close = value.lastIndexOf(")");
  let name: string;
  let specifier: string | undefined;
  if (open < 0 && close < 0) name = value;
  else {
    if (open <= 0 || close !== value.length - 1 || close <= open || value.slice(0, open).includes(")"))
      return fail("malformed tool specifier");
    name = value.slice(0, open);
    specifier = value.slice(open + 1, close);
    if (!specifier.trim()) return fail("specifier must be non-empty");
  }
  if (!name.trim() || name !== name.trim())
    return fail("tool name must be non-empty and have no surrounding whitespace");
  const key = name.toLowerCase();
  const tool = BUILTINS.get(key) ?? name;
  if (specifier !== undefined && !["bash", "read", "edit", "write"].includes(tool))
    return fail(`tool specifier is unsupported for ${name}`);
  return {
    ok: true,
    value: { tool, ...(specifier === undefined ? {} : { specifier }), level, label: value, source, scope },
  };
}

function normalizeToolPath(input: string): string {
  let normalized = input.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") normalized = homedir();
  else if (normalized.startsWith("~/")) normalized = join(homedir(), normalized.slice(2));
  if (/^file:\/\//.test(normalized)) normalized = fileURLToPath(normalized);
  return normalized;
}
export function resolveToolPath(input: string, cwd: string): string {
  return resolve(cwd, normalizeToolPath(input));
}

function readCandidates(path: string): string[] {
  const amPm = path.replace(/ (AM|PM)\./gi, "\u202f$1.");
  const nfd = path.normalize("NFD");
  const curly = path.replace(/'/g, "\u2019");
  return [path, amPm, nfd, curly, nfd.replace(/'/g, "\u2019")];
}
function resolveReadPath(input: string, cwd: string): string {
  const path = resolveToolPath(input, cwd);
  return readCandidates(path).find((candidate) => existsSync(candidate)) ?? path;
}
function globRegex(pattern: string, slashStar: boolean, wildcard = "*"): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    if (pattern.startsWith(wildcard + wildcard, index)) {
      source += "[\\s\\S]*";
      index += wildcard.length * 2 - 1;
    } else if (pattern.startsWith(wildcard, index)) {
      source += slashStar ? "[^/]*" : "[\\s\\S]*";
      index += wildcard.length - 1;
    } else source += pattern[index]!.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`^(?:${source})(?![\\s\\S])`);
}
export function tokenizeAllowRule(specifier: string): { ok: true; words: readonly string[] } | { ok: false } {
  const words: string[] = [];
  let quote: string | undefined;
  let word: string | undefined;
  for (const char of specifier) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else word = (word ?? "") + char;
    } else if (char === "'" || char === '"') {
      quote = char;
      word ??= "";
    } else if (/\s/.test(char)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else {
      word = (word ?? "") + char;
    }
  }
  if (word !== undefined) words.push(word);
  return quote === undefined && words.length > 0 ? { ok: true, words } : { ok: false };
}

export function allowWordsMatch(ruleWords: readonly string[], commandWords: readonly string[]): boolean {
  const patterns = ruleWords.map((word) => (word === "*" ? undefined : globRegex(word, true)));
  for (const word of ruleWords) {
    const key = /^[^*/=]+=/u.exec(word)?.[0];
    if (key !== undefined && commandWords.filter((arg) => arg.startsWith(key)).length > 1) return false;
  }

  let rule = 0;
  let command = 0;
  let star = -1;
  let starEnd = 0;
  while (true) {
    const arg = commandWords[command];
    if (arg === undefined) break;
    if (ruleWords[rule] === "*") {
      star = rule++;
      starEnd = command;
    } else if (
      patterns[rule]?.test(arg) &&
      !(
        ruleWords[rule]?.includes("/") &&
        arg
          .replace(/^[^/=]+=/u, "")
          .split("/")
          .includes("..")
      )
    ) {
      rule++;
      command++;
    } else if (star !== -1) {
      // Retry after the last whole-word star, letting it consume one more word.
      rule = star + 1;
      command = ++starEnd;
    } else {
      return false;
    }
  }
  return ruleWords.slice(rule).every((word) => word === "*");
}

function matchesText(pattern: string, text: string, slashStar: boolean): boolean {
  return globRegex(pattern, slashStar).test(text);
}
function bashMatches(specifier: string, command: string, scanSegments: boolean): boolean {
  if (matchesText(specifier, command, false)) return true;
  if (!scanSegments) return false;
  return command
    .split(SHELL_SEGMENT_DELIMITER)
    .some((segment) => segment.trim() !== "" && matchesText(specifier, segment.trim(), false));
}
function filePatternMatches(
  specifier: string,
  actual: string,
  cwd: string,
  folded: boolean,
  resolveAnchor = false,
): boolean {
  const compare = folded ? foldPath : (path: string) => path;
  const isUrl = specifier.startsWith("file://");
  const decoded = isUrl ? fileURLToPath(specifier) : specifier;
  const isHomeRelative = specifier.startsWith("~/");
  const home = homedir();
  let anchor = cwd;
  let pattern = specifier;
  if (resolveAnchor && !isUrl && !isHomeRelative && !isAbsolute(specifier)) {
    // Pi applies leading dot segments to the lexical cwd before following symlinks.
    const dots = sep === "\\" ? /^(?:\.{1,2}(?:[/\\]+|$))+/ : /^(?:\.{1,2}(?:\/+|$))+/;
    const leading = dots.exec(specifier)?.[0] ?? "";
    try {
      anchor = resolvePathForPolicy(leading, cwd);
    } catch {
      return false; // No resolved match; deny and ask already checked the lexical path.
    }
    pattern = specifier.slice(leading.length);
  }
  // Mark written wildcards before URL decoding or adding literal cwd/HOME characters.
  // An uncased marker preserves case folding, and its opening bracket cannot overlap its suffix.
  let nonce = 0;
  let wildcard = `[${nonce}]`;
  while ([specifier, decoded, anchor, home].some((value) => value.includes(wildcard))) wildcard = `[${++nonce}]`;
  let configured = pattern.replaceAll("*", wildcard);
  if (isUrl) configured = fileURLToPath(configured);
  else if (isHomeRelative) configured = join(home, configured.slice(2));
  return globRegex(compare(resolve(anchor, configured)), true, wildcard).test(compare(actual));
}

export function ruleMatches(rule: PermissionRule, call: ToolCall, cwd: string, scanSegments = true): boolean {
  const tool = rule.tool === "edit" && call.toolName === "write" ? "edit" : call.toolName;
  if (tool !== rule.tool) return false;
  if (rule.specifier === undefined) return true;
  if (rule.tool === "bash") {
    if (!isObject(call.input) || typeof call.input.command !== "string") return false;
    return bashMatches(rule.specifier, call.input.command, scanSegments && rule.level !== "allow");
  }
  if (["read", "edit", "write"].includes(rule.tool)) {
    if (!isObject(call.input) || typeof call.input.path !== "string") return false;
    const folded = rule.level !== "allow";
    const lexical = resolveToolPath(call.input.path, cwd);
    if (folded && filePatternMatches(rule.specifier, lexical, cwd, true)) return true;
    const actual = rule.tool === "read" ? resolveReadPath(call.input.path, cwd) : lexical;
    if (folded && actual !== lexical && filePatternMatches(rule.specifier, actual, cwd, true)) return true;
    let resolved: string;
    try {
      resolved = resolvePathForPolicy(actual);
    } catch {
      return folded; // With no reliable target, deny or ask rather than grant access.
    }
    return filePatternMatches(rule.specifier, resolved, cwd, folded, true);
  }
  return false;
}

export function matchPermissionExact(call: ToolCall, cwd: string, rules: readonly PermissionRule[], projectTrusted: boolean): PermissionRule | undefined {
  return matchPermission(call, cwd, rules, projectTrusted, false);
}

export function matchPermission(
  call: ToolCall,
  cwd: string,
  rules: readonly PermissionRule[],
  projectTrusted: boolean,
  scanSegments = true,
): PermissionRule | undefined {
  for (const level of ["deny", "ask", "allow"] as const) {
    for (const scope of ["global", "project"] as const) {
      if (scope === "project" && level === "allow" && !projectTrusted) continue;
      const match = rules.find((rule) => rule.level === level && rule.scope === scope && ruleMatches(rule, call, cwd, scanSegments));
      if (match) return match;
    }
  }
  return undefined;
}
