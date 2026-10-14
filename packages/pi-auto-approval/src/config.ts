import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, statSync, chmodSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

export type RuleLevel = "deny" | "ask" | "allow";
export type ReviewMode = "manual" | "auto";
export interface Rule {
  readonly pattern: RegExp;
  readonly level: RuleLevel;
  readonly label: string;
  readonly message?: string;
  readonly source: string;
  readonly scope: "global" | "project";
}
export interface PermissionSettings { readonly enabled: boolean; readonly reviewMode: ReviewMode }
export interface SessionChoices { readonly enabled?: boolean; readonly reviewMode?: ReviewMode }
export type UiPlacement = "widget" | "toolRow";
export interface ConfigUi { readonly status: boolean; readonly placement: UiPlacement }
export interface ReviewEvidenceConfig { readonly projectInstructions: boolean }
export const DEFAULT_REVIEW_EVIDENCE: ReviewEvidenceConfig = { projectInstructions: false };
export interface ProjectInstructions { readonly source: "AGENTS.md" | "CLAUDE.md"; readonly content: string }
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "low";
export const REVIEW_TIMEOUT_DEFAULT_MS = 30_000;
export const REVIEW_TIMEOUT_MIN_MS = 1_000;
export const REVIEW_TIMEOUT_MAX_MS = 300_000;
export interface ReviewerConfig {
  readonly model?: { readonly provider: string; readonly id: string };
  readonly reasoningEffort: ReasoningEffort;
  readonly timeoutMs: number;
  readonly extraInstructions?: string;
}
export const DEFAULT_REVIEWER: ReviewerConfig = { reasoningEffort: DEFAULT_REASONING_EFFORT, timeoutMs: REVIEW_TIMEOUT_DEFAULT_MS };
export type ConfigResult =
  | ({ readonly ok: true; readonly rules: readonly Rule[]; readonly ui: ConfigUi; readonly reviewer: ReviewerConfig; readonly reviewEvidence: ReviewEvidenceConfig } & PermissionSettings)
  | { readonly ok: false; readonly error: string };
export const CONFIG_FILENAME = "auto-permissions.json";
const ALLOWED_FLAGS = "dimsuv";
type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isNonBlank(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function checkKeys(value: Record<string, unknown>, keys: readonly string[], where: string): string | undefined {
  for (const key of Object.keys(value)) if (!keys.includes(key)) return `${where}: unsupported field "${key}"`;
  return undefined;
}
function parseFlags(flags: unknown, where: string): Parsed<string> {
  if (flags === undefined) return { ok: true, value: "" };
  if (typeof flags !== "string") return fail(`${where}: flags must be a string`);
  if (/[gy]/.test(flags)) return fail(`${where}: flags must not include g or y (stateful matching)`);
  if ([...flags].some((f) => !ALLOWED_FLAGS.includes(f))) return fail(`${where}: flags contain an unsupported character`);
  return { ok: true, value: flags };
}
function parseRule(entry: unknown, where: string, source: string, scope: "global" | "project"): Parsed<Rule> {
  if (!isObject(entry)) return fail(`${where} must be an object`);
  const unknown = checkKeys(entry, ["pattern", "flags", "level", "label", "message"], where);
  if (unknown) return fail(unknown);
  if (!isNonBlank(entry.pattern)) return fail(`${where}: pattern must be a non-empty string`);
  if (!isNonBlank(entry.label)) return fail(`${where}: label must be a non-empty string`);
  if (typeof entry.level !== "string" || !["deny", "ask", "allow"].includes(entry.level)) return fail(`${where}: level must be "deny", "ask", or "allow"`);
  const flags = parseFlags(entry.flags, where);
  if (!flags.ok) return flags;
  let pattern: RegExp;
  try { pattern = new RegExp(entry.pattern, flags.value); } catch (err) { return fail(`${where}: invalid regex (${(err as Error).message})`); }
  if (entry.message !== undefined && !isNonBlank(entry.message)) return fail(`${where}: message must be a non-empty string`);
  return { ok: true, value: { pattern, level: entry.level as RuleLevel, label: entry.label, ...(entry.message === undefined ? {} : { message: entry.message as string }), source, scope } };
}
function parseNested<T>(raw: unknown, source: string, key: string, allowed: readonly string[], parse: (obj: Record<string, unknown>) => Parsed<T>, fallback: T): Parsed<T> {
  if (raw === undefined) return { ok: true, value: fallback };
  if (!isObject(raw)) return fail(`${source}: ${key} must be an object`);
  const unknown = checkKeys(raw, allowed, `${source}: ${key}`);
  return unknown ? fail(unknown) : parse(raw);
}
function parseReviewer(raw: unknown, source: string, baseDir: string): Parsed<ReviewerConfig> {
  return parseNested(raw, source, "reviewer", ["provider", "model", "reasoningEffort", "timeoutMs", "extraInstructions", "extraInstructionsFile"], (obj) => {
    if ((obj.provider === undefined) !== (obj.model === undefined)) return fail(`${source}: reviewer.provider and reviewer.model must be set together`);
    if (obj.provider !== undefined && (!isNonBlank(obj.provider) || !isNonBlank(obj.model))) return fail(`${source}: reviewer.provider and reviewer.model must be non-empty strings`);
    let reasoningEffort: ReasoningEffort = DEFAULT_REASONING_EFFORT;
    if (obj.reasoningEffort !== undefined) {
      if (!REASONING_EFFORTS.includes(obj.reasoningEffort as ReasoningEffort)) return fail(`${source}: reviewer.reasoningEffort must be one of ${REASONING_EFFORTS.join(", ")}`);
      reasoningEffort = obj.reasoningEffort as ReasoningEffort;
    }
    let timeoutMs = REVIEW_TIMEOUT_DEFAULT_MS;
    if (obj.timeoutMs !== undefined) {
      if (typeof obj.timeoutMs !== "number" || !Number.isInteger(obj.timeoutMs) || obj.timeoutMs < REVIEW_TIMEOUT_MIN_MS || obj.timeoutMs > REVIEW_TIMEOUT_MAX_MS) return fail(`${source}: reviewer.timeoutMs must be an integer from ${REVIEW_TIMEOUT_MIN_MS} to ${REVIEW_TIMEOUT_MAX_MS}`);
      timeoutMs = obj.timeoutMs;
    }
    if (obj.extraInstructions !== undefined && obj.extraInstructionsFile !== undefined) return fail(`${source}: reviewer.extraInstructions and reviewer.extraInstructionsFile are mutually exclusive`);
    let extraInstructions: string | undefined;
    if (obj.extraInstructions !== undefined) {
      if (!isNonBlank(obj.extraInstructions)) return fail(`${source}: reviewer.extraInstructions must be a non-empty string`);
      extraInstructions = obj.extraInstructions;
    } else if (obj.extraInstructionsFile !== undefined) {
      if (!isNonBlank(obj.extraInstructionsFile)) return fail(`${source}: reviewer.extraInstructionsFile must be a non-empty string`);
      const path = resolve(baseDir, obj.extraInstructionsFile);
      try { extraInstructions = readFileSync(path, "utf8"); } catch { return fail(`${source}: reviewer.extraInstructionsFile cannot be read (${path})`); }
      if (extraInstructions.trim() === "") return fail(`${source}: reviewer.extraInstructionsFile is empty (${path})`);
    }
    return { ok: true, value: { ...(obj.provider === undefined ? {} : { model: { provider: obj.provider as string, id: obj.model as string } }), reasoningEffort, timeoutMs, ...(extraInstructions === undefined ? {} : { extraInstructions }) } };
  }, DEFAULT_REVIEWER);
}
export function parseConfig(raw: unknown, source: string, baseDir = ".", scope: "global" | "project" = "global"): ConfigResult {
  if (!isObject(raw)) return fail(`${source}: root must be an object`);
  const allowed = scope === "global" ? ["enabled", "reviewMode", "rules", "reviewer", "reviewEvidence", "ui"] : ["rules"];
  const unknown = checkKeys(raw, allowed, source);
  if (unknown) return fail(unknown);
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") return fail(`${source}: enabled must be a boolean`);
  if (raw.reviewMode !== undefined && raw.reviewMode !== "manual" && raw.reviewMode !== "auto") return fail(`${source}: reviewMode must be "manual" or "auto"`);
  if (raw.rules !== undefined && !Array.isArray(raw.rules)) return fail(`${source}: rules must be an array`);
  const rules: Rule[] = [];
  for (const [i, entry] of (raw.rules as unknown[] | undefined ?? []).entries()) {
    const rule = parseRule(entry, `${source}: rules[${i}]`, source, scope);
    if (!rule.ok) return rule;
    rules.push(rule.value);
  }
  const reviewer = parseReviewer(raw.reviewer, source, baseDir);
  if (!reviewer.ok) return reviewer;
  const evidence = parseNested(raw.reviewEvidence, source, "reviewEvidence", ["projectInstructions"], (obj) => {
    if (obj.projectInstructions !== undefined && typeof obj.projectInstructions !== "boolean") return fail(`${source}: reviewEvidence.projectInstructions must be a boolean`);
    return { ok: true, value: { projectInstructions: obj.projectInstructions === true } };
  }, DEFAULT_REVIEW_EVIDENCE);
  if (!evidence.ok) return evidence;
  const ui = parseNested<ConfigUi>(raw.ui, source, "ui", ["status", "placement"], (obj) => {
    if (obj.status !== undefined && typeof obj.status !== "boolean") return fail(`${source}: ui.status must be a boolean`);
    if (obj.placement !== undefined && obj.placement !== "widget" && obj.placement !== "toolRow") return fail(`${source}: ui.placement must be widget or toolRow`);
    const placement: UiPlacement = obj.placement === "toolRow" ? "toolRow" : "widget";
    return { ok: true, value: { status: obj.status !== false, placement } };
  }, { status: true, placement: "widget" });
  if (!ui.ok) return ui;
  return { ok: true, enabled: scope === "global" ? (raw.enabled as boolean | undefined ?? true) : true, reviewMode: scope === "global" ? (raw.reviewMode as ReviewMode | undefined ?? "manual") : "manual", rules, reviewer: reviewer.value, reviewEvidence: evidence.value, ui: ui.value };
}
function readConfig(path: string, scope: "global" | "project"): ConfigResult {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: true, enabled: true, reviewMode: "manual", rules: [], ui: { status: true, placement: "widget" }, reviewer: DEFAULT_REVIEWER, reviewEvidence: DEFAULT_REVIEW_EVIDENCE };
    return { ok: false, error: `${path}: cannot read config (${code ?? "unknown error"})` };
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (err) { return { ok: false, error: `${path}: invalid JSON (${(err as Error).message})` }; }
  return parseConfig(raw, path, dirname(path), scope);
}
export function loadGlobalConfig(globalDir: string): ConfigResult { return readConfig(join(globalDir, CONFIG_FILENAME), "global"); }
export function loadConfig(cwd: string, globalDir: string): ConfigResult {
  const globalPath = join(globalDir, CONFIG_FILENAME);
  const projectPath = join(cwd, ".pi", CONFIG_FILENAME);
  const global = readConfig(globalPath, "global");
  if (!global.ok) return global;
  const project = readConfig(projectPath, "project");
  if (!project.ok) return project;
  return { ...global, rules: [...global.rules, ...project.rules] };
}
export type SaveResult = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly path: string; readonly error: string };
export function saveGlobalReviewerModel(
  globalDir: string,
  model: NonNullable<ReviewerConfig["model"]> | undefined,
): SaveResult {
  const path = join(globalDir, CONFIG_FILENAME);
  let before: string | undefined;
  let raw: Record<string, unknown> = { rules: [] };
  try { before = readFileSync(path, "utf8"); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, path, error: `cannot read config (${(err as NodeJS.ErrnoException).code ?? "unknown error"})` };
  }
  if (before !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(before); } catch (err) { return { ok: false, path, error: `invalid JSON (${(err as Error).message})` }; }
    const checked = parseConfig(parsed, path, dirname(path));
    if (!checked.ok) return { ok: false, path, error: checked.error };
    if (model === undefined && checked.reviewer.model === undefined) return { ok: true, path };
    raw = parsed as Record<string, unknown>;
  }
  if (model === undefined) {
    if (raw.reviewer !== undefined) {
      const reviewer = raw.reviewer as Record<string, unknown>;
      delete reviewer.provider;
      delete reviewer.model;
      if (Object.keys(reviewer).length === 0) delete raw.reviewer;
    }
    if (before === undefined || JSON.stringify(JSON.parse(before)) === JSON.stringify(raw)) return { ok: true, path };
  } else {
    if (!isNonBlank(model.provider) || !isNonBlank(model.id)) return { ok: false, path, error: `${path}: reviewer.provider and reviewer.model must be non-empty strings` };
    const reviewer = isObject(raw.reviewer) ? raw.reviewer : {};
    raw.reviewer = { ...reviewer, provider: model.provider, model: model.id };
  }
  const checked = parseConfig(raw, path, dirname(path));
  if (!checked.ok) return { ok: false, path, error: checked.error };
  const output = JSON.stringify(raw, null, 2) + "\n";
  const stage = join(globalDir, `.${CONFIG_FILENAME}.${randomUUID()}.tmp`);
  let committed = false;
  try {
    mkdirSync(globalDir, { recursive: true });
    const mode = before === undefined ? undefined : (() => { const stat = statSync(path); return stat.isFile() ? stat.mode & 0o7777 : undefined; })();
    writeFileSync(stage, output, { encoding: "utf8", flag: "wx", ...(mode === undefined ? {} : { mode }) });
    if (mode !== undefined) chmodSync(stage, mode);
    let current: string | undefined;
    try { current = readFileSync(path, "utf8"); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    if (current !== before) return { ok: false, path, error: "config changed during save; refusing to overwrite" };
    renameSync(stage, path);
    committed = true;
    return { ok: true, path };
  } catch (err) {
    return { ok: false, path, error: (err as Error).message };
  } finally {
    if (!committed) { try { rmSync(stage, { force: true }); } catch { /* best-effort staging cleanup */ } }
  }
}
export function saveGlobalSettings(globalDir: string, settings: PermissionSettings): SaveResult {
  const path = join(globalDir, CONFIG_FILENAME);
  let before: string | undefined;
  let raw: Record<string, unknown> = {};
  try { before = readFileSync(path, "utf8"); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, path, error: `cannot read config (${(err as NodeJS.ErrnoException).code ?? "unknown error"})` }; }
  if (before !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(before); } catch (err) { return { ok: false, path, error: `invalid JSON (${(err as Error).message})` }; }
    const checked = parseConfig(parsed, path, dirname(path));
    if (!checked.ok) return { ok: false, path, error: checked.error };
    raw = parsed as Record<string, unknown>;
  }
  const output = JSON.stringify(before === undefined ? { enabled: settings.enabled, reviewMode: settings.reviewMode, rules: [] } : { ...raw, enabled: settings.enabled, reviewMode: settings.reviewMode }, null, 2) + "\n";
  try {
    mkdirSync(globalDir, { recursive: true });
    let current: string | undefined;
    try { current = readFileSync(path, "utf8"); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    if (current !== before) return { ok: false, path, error: "config changed during save; refusing to overwrite" };
    writeFileSync(path, output, "utf8");
    return { ok: true, path };
  } catch (err) { return { ok: false, path, error: (err as Error).message }; }
}
export function loadProjectInstructions(cwd: string): ProjectInstructions | undefined {
  for (const source of ["AGENTS.md", "CLAUDE.md"] as const) {
    const path = join(cwd, source);
    let content: string;
    try { content = readFileSync(path, "utf8"); } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      throw new Error(`cannot read ${path} (${code ?? "unknown error"})`);
    }
    if (content.trim() === "") return undefined;
    return { source, content };
  }
  return undefined;
}
