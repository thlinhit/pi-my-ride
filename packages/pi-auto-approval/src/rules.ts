import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuleLevel } from "./config.ts";

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
function filePatternMatches(specifier: string, actual: string, cwd: string): boolean {
  const isUrl = specifier.startsWith("file://");
  const decoded = isUrl ? fileURLToPath(specifier) : specifier;
  const home = homedir();
  // Mark written wildcards before URL decoding or adding literal cwd/HOME characters.
  // P occurs only at the start, so no marker prefix can overlap its suffix.
  let nonce = 0;
  let wildcard = `PI${nonce}Z`;
  while ([specifier, decoded, cwd, home].some((value) => value.includes(wildcard))) wildcard = `PI${++nonce}Z`;
  let configured = specifier.replaceAll("*", wildcard);
  if (isUrl) configured = fileURLToPath(configured);
  else if (configured.startsWith("~/")) configured = join(home, configured.slice(2));
  return globRegex(resolve(cwd, configured), true, wildcard).test(actual);
}

export function ruleMatches(rule: PermissionRule, call: ToolCall, cwd: string): boolean {
  const tool = rule.tool === "edit" && call.toolName === "write" ? "edit" : call.toolName;
  if (tool !== rule.tool) return false;
  if (rule.specifier === undefined) return true;
  if (rule.tool === "bash") {
    if (!isObject(call.input) || typeof call.input.command !== "string") return false;
    return bashMatches(rule.specifier, call.input.command, rule.level !== "allow");
  }
  if (["read", "edit", "write"].includes(rule.tool)) {
    if (!isObject(call.input) || typeof call.input.path !== "string") return false;
    const actual = rule.tool === "read" ? resolveReadPath(call.input.path, cwd) : resolveToolPath(call.input.path, cwd);
    return filePatternMatches(rule.specifier, actual, cwd);
  }
  return false;
}

export function matchPermission(
  call: ToolCall,
  cwd: string,
  rules: readonly PermissionRule[],
  projectTrusted: boolean,
): PermissionRule | undefined {
  for (const level of ["deny", "ask", "allow"] as const) {
    for (const scope of ["global", "project"] as const) {
      if (scope === "project" && level === "allow" && !projectTrusted) continue;
      const match = rules.find((rule) => rule.level === level && rule.scope === scope && ruleMatches(rule, call, cwd));
      if (match) return match;
    }
  }
  return undefined;
}
