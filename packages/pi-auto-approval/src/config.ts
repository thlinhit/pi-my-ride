import { readFileSync } from "node:fs";
import { join } from "node:path";

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

export type ConfigResult =
  | { readonly ok: true; readonly rules: readonly Rule[]; readonly source: string | null; readonly ui: ConfigUi }
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

/** Pure. Validates parsed JSON and compiles regexes. Never throws; returns { ok:false } instead. */
export function parseConfig(raw: unknown, source: string): ConfigResult {
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

  return { ok: true, rules, source, ui: ui.value };
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
    return parseConfig(raw, path);
  }

  return { ok: true, rules: [], source: null, ui: { status: true } };
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
