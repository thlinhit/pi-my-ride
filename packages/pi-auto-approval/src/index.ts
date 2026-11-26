import { join } from "node:path";
import { VERSION } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PermissionRule, SessionChoices } from "./config.ts";
import { CONFIG_FILENAME, ensureGlobalConfig, globalConfigDir, loadConfig } from "./config.ts";
import { analyzeShell } from "./shell.ts";
import { isReadOnlyComponent } from "./readonly.ts";
import { matchPermission, matchPermissionExact } from "./rules.ts";
import { createPermissionsController, isTrustedProject } from "./permissions.ts";
import { effectiveSettings, type PermissionConfig } from "./ui/footer.ts";
import { recordHistory, type HistoryEntry, type HistoryResult } from "./history.ts";
import { createReviewDisplay } from "./ui/display.ts";
import type { ConfigUi } from "./config.ts";
import type { ReviewState } from "./ui/status.ts";
import type { ReviewContext, ReviewResult, Reviewer } from "./review/session.ts";
import { createPiReviewer, createReviewerState } from "./review/session.ts";

export type { ReviewContext, ReviewInput, ReviewResult, Reviewer, ReviewerState } from "./review/session.ts";
export { createPiReviewer, createReviewerState } from "./review/session.ts";
export interface GateContext {
  readonly cwd: string;
  readonly hasUI: boolean;
  readonly signal: AbortSignal | undefined;
  isProjectTrusted(): boolean;
  readonly ui: { confirm(title: string, message: string, opts?: { signal?: AbortSignal }): Promise<boolean>; notify(message: string, type?: "info" | "warning" | "error"): void };
}
export type ConfigLoader = (cwd: string) => PermissionConfig;
export interface GateReport {
  readonly state: ReviewState;
  readonly label: string;
  readonly source?: string;
  readonly reviewer?: string;
  readonly detail?: string;
  readonly ui: ConfigUi;
}
export type StatusReporter = (report: GateReport) => void;
export interface GateDeps {
  readonly matcher?: (call: { toolName: string; input: unknown }, cwd: string, rules: readonly PermissionRule[], projectTrusted: boolean) => PermissionRule | undefined;
  readonly status?: StatusReporter;
  readonly reviewer?: string;
  readonly review?: Reviewer;
  readonly history?: (entry: HistoryEntry) => HistoryResult;
}
export type GateStatus = ReviewState;
export type GateDecision = { block: true; reason: string } | undefined;
const CONFIRMATION_FAILED = "auto-approval: confirmation failed";
const block = (reason: string): { block: true; reason: string } => ({ block: true, reason });
type GateOutcome = { kind: "not-gated" } | { kind: "decided"; decision: GateDecision; log: boolean };
const NOT_GATED: GateOutcome = { kind: "not-gated" };
const PATH_TOOLS = new Set(["read", "edit", "write"]);
function historyCommandOf(toolName: string, input: unknown): string {
  const value = input !== null && typeof input === "object" ? (input as Record<string, unknown>)[PATH_TOOLS.has(toolName) ? "path" : "command"] : undefined;
  return typeof value === "string" ? value : "";
}
function bashCommandOf(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const { command } = input as { command?: unknown };
  return typeof command === "string" ? command : undefined;
}
const EXCERPT_LIMIT = 2000;
function callExcerpt(toolName: string, input: unknown): string {
  const json = JSON.stringify(input) ?? String(input);
  return `${toolName} ${json.length > EXCERPT_LIMIT ? `${json.slice(0, EXCERPT_LIMIT)}...` : json}`;
}
function safeNotify(ctx: GateContext, message: string): void { try { ctx.ui.notify(message); } catch {} }
function isAborted(ctx: GateContext): boolean { return ctx.signal?.aborted === true; }
function snapshotGate(ctx: GateContext, choices: SessionChoices, load?: ConfigLoader) {
  let config: PermissionConfig | undefined;
  try {
    config = load?.(ctx.cwd);
  } catch {}
  const projectTrusted = isTrustedProject(ctx);
  return { config, projectTrusted, settings: effectiveSettings(config, choices, projectTrusted) };
}

function recordGateOutcome(
  event: { toolName: string; input: unknown },
  outcome: GateOutcome,
  record: (entry: HistoryEntry) => HistoryResult,
  warn: (message: string) => void,
): void {
  if (outcome.kind !== "decided" || !outcome.log) return;
  let result: HistoryResult;
  try {
    result = record({
      tool: event.toolName,
      command: historyCommandOf(event.toolName, event.input),
      decision: outcome.decision ? "blocked" : "approved",
    });
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!result.ok) warn(`Could not record auto-approval history: ${result.error}`);
}
function safeWarn(ctx: GateContext, message: string): void { try { ctx.ui.notify(message, "warning"); } catch {} }

export async function handleToolCall(event: { toolName: string; input: unknown; toolCallId?: string }, ctx: GateContext, load: ConfigLoader, deps: GateDeps = {}, choices: SessionChoices = {}): Promise<GateDecision> {
  const snapshot = snapshotGate(ctx, choices, choices.enabled === false ? undefined : load);
  const outcome = await gateToolCall(event, ctx, snapshot, deps, choices, new Set());
  if (deps.history) recordGateOutcome(event, outcome, deps.history, (message) => safeWarn(ctx, message));
  return outcome.kind === "decided" ? outcome.decision : undefined;
}

type GateSnapshot = ReturnType<typeof snapshotGate>;

async function gateToolCall(
  event: { toolName: string; input: unknown },
  ctx: GateContext,
  snapshot: GateSnapshot,
  deps: GateDeps,
  choices: SessionChoices,
  noticedFiles: Set<string>,
): Promise<GateOutcome> {
  const decision = await decideToolCall(event, ctx, snapshot, deps, choices, noticedFiles);
  return !snapshot.settings.enabled && decision === undefined
    ? NOT_GATED
    : { kind: "decided", decision, log: snapshot.settings.enabled };
}

async function decideToolCall(
  event: { toolName: string; input: unknown },
  ctx: GateContext,
  { config, projectTrusted, settings }: GateSnapshot,
  deps: GateDeps,
  choices: SessionChoices,
  noticedFiles: Set<string>,
): Promise<GateDecision> {
  if (isAborted(ctx)) return block(CONFIRMATION_FAILED);
  const bash = event.toolName === "bash";
  const command = bashCommandOf(event.input);
  if (bash && command === undefined) return block("auto-approval: invalid bash input");
  if (choices.enabled === false) return undefined;
  if (!config) return block("auto-approval: config load failed");
  if (!config.ok) return block(`auto-approval: invalid config - ${config.error}. Fix it to run tools.`);
  if (!projectTrusted) {
    const ignoredFiles = new Set<string>();
    for (const file of [config.project?.shared, config.project?.local]) {
      if (file && (file.settings.enabled !== undefined || file.settings.reviewMode !== undefined))
        ignoredFiles.add(file.source);
    }
    for (const rule of config.rules) {
      if (rule.scope === "project" && rule.level === "allow") ignoredFiles.add(rule.source);
    }
    for (const file of ignoredFiles) {
      if (noticedFiles.has(file)) continue;
      noticedFiles.add(file);
      safeNotify(ctx, `Ignored project settings from ${file} because the project is untrusted.`);
    }
  }
  if (isAborted(ctx)) return block(CONFIRMATION_FAILED);
  if (!settings.enabled) return undefined;
  const mode = settings.reviewMode;
  const analysis = bash ? analyzeShell(command!) : undefined;
  const matcher = deps.matcher ?? (bash ? matchPermissionExact : matchPermission);
  let rule: PermissionRule | undefined;
  try {
    rule = matcher({ toolName: event.toolName, input: event.input }, ctx.cwd, config.rules, projectTrusted);
    if (bash && !analysis?.supported) rule = matchPermission(event, ctx.cwd, config.rules.filter(candidate => candidate.level !== "allow"), projectTrusted) ?? rule;
  } catch { return block("auto-approval: matcher error"); }
  if (isAborted(ctx)) return block(CONFIRMATION_FAILED);
  const label = rule?.label ?? (bash ? "Unmatched Bash command" : `Unmatched ${event.toolName} call`);
  const reviewerConfig = choices.reviewerModel === undefined ? config.reviewer : { ...config.reviewer, model: choices.reviewerModel ?? undefined };
  const reviewer = reviewerConfig.model ? `${reviewerConfig.model.provider}/${reviewerConfig.model.id}` : deps.reviewer;
  const report = (state: ReviewState, detail?: string) => {
    if (!ctx.hasUI || !settings.debug || !config.ui.status || !deps.status || isAborted(ctx)) return;
    try { deps.status({ state, label, ...(rule?.source ? { source: rule.source } : {}), ...(state === "guardian-running" && reviewer ? { reviewer } : {}), ...(detail ? { detail } : {}), ui: config.ui }); } catch {}
  };
  const attribution = rule ? `(${rule.label}, ${rule.source})` : "";
  const confirm = async (reason: string): Promise<GateDecision> => {
    if (!ctx.hasUI) return block(reason);
    if (isAborted(ctx)) return block(CONFIRMATION_FAILED);
    report("approval-required");
    if (isAborted(ctx)) return block(CONFIRMATION_FAILED);
    try {
      const approved = await ctx.ui.confirm(
        `Approve command?${rule ? ` [${rule.label}]` : ""}`,
        `${reason}\n\n${bash ? command : callExcerpt(event.toolName, event.input)}`,
        { signal: ctx.signal },
      );
      if (isAborted(ctx) || approved !== true) {
        report("blocked", isAborted(ctx) ? "Cancelled" : undefined);
        return block(`${reason}${isAborted(ctx) ? " (review cancelled)" : " (user declined)"}`);
      }
      report("approved");
      return isAborted(ctx) ? block(CONFIRMATION_FAILED) : undefined;
    } catch {
      report("blocked");
      return block(`${reason} (confirmation failed)`);
    }
  };
  if (rule?.level === "deny") {
    report("blocked");
    return block(`Blocked by auto-approval ${attribution}`);
  }
  if (analysis && !analysis.supported && !analysis.reviewable)
    return confirm(`${analysis.reason} requires confirmation`);
  if (bash && analysis?.supported) {
    const reasons: string[] = rule?.level === "ask" ? [`Requires confirmation ${attribution}`] : [];
    let componentRules: (PermissionRule | undefined)[];
    try {
      componentRules = analysis.components.map((component) =>
        matcher({ toolName: "bash", input: { command: component.command } }, ctx.cwd, config.rules, projectTrusted),
      );
    } catch {
      return block("auto-approval: matcher error");
    }
    const denied = componentRules.find((candidate) => candidate?.level === "deny");
    if (denied) {
      report("blocked");
      return block(`Blocked by auto-approval (${denied.label}, ${denied.source})`);
    }
    for (let index = 0; index < analysis.components.length; index++) {
      if (isAborted(ctx)) return block(CONFIRMATION_FAILED);
      const component = analysis.components[index]!;
      const componentRule = componentRules[index];
      if (componentRule?.level === "allow") {
        if (settings.debug) safeNotify(ctx, `Allowed by rule (${componentRule.label}, ${componentRule.source})`);
        continue;
      }
      if (componentRule?.level === "ask") { reasons.push(`Requires confirmation (${componentRule.label}, ${componentRule.source})`); continue; }
      if (isReadOnlyComponent(component.command)) {
        if (settings.debug) safeNotify(ctx, "Allowed as read-only command");
        continue;
      }
      if (mode === "manual") { reasons.push(`${label} requires confirmation`); continue; }
      report("guardian-running");
      if (isAborted(ctx)) return block(CONFIRMATION_FAILED);
      let result: ReviewResult;
      try {
        result = deps.review ? await deps.review({ command: component.command, component: { originalCommand: command!, index: index + 1, count: analysis.components.length, start: component.start, end: component.end, context: component.context }, reviewer: reviewerConfig, reviewEvidence: config.reviewEvidence, signal: ctx.signal }) : { ok: false, error: "reviewer unavailable" };
      } catch { result = { ok: false, error: "reviewer unavailable" }; }
      if (isAborted(ctx)) { report("blocked", "Cancelled"); return block(CONFIRMATION_FAILED); }
      if (!result.ok) {
        if (result.cancelled) {
          report("blocked", "Cancelled");
          return block("Review cancelled");
        }
        reasons.push(`Automatic review failed: ${result.error}`);
        continue;
      }
      if (result.verdict.decision === "revise") {
        report("revision-requested");
        reasons.push(`Reviewer requested a revision: ${result.verdict.reason}\nConstraint: ${result.verdict.constraint}\nSource: ${result.verdict.source}\nApprove the original action once?`);
        continue;
      }
      if (result.verdict.decision === "ask_user") reasons.push(`Reviewer needs user approval: ${result.verdict.reason}`);
    }
    if (isAborted(ctx)) return block(CONFIRMATION_FAILED);
    if (reasons.length) return confirm([...new Set(reasons)].join("\n"));
    report("approved");
    return isAborted(ctx) ? block(CONFIRMATION_FAILED) : undefined;
  }
  if (rule?.level === "ask") return confirm(`Requires confirmation ${attribution}`);
  if (rule?.level === "allow" && !bash) {
    if (settings.debug) safeNotify(ctx, `Allowed by rule (${rule.label}, ${rule.source})`);
    report("approved");
    return isAborted(ctx) ? block(CONFIRMATION_FAILED) : undefined;
  }
  if (mode === "manual") return confirm(`${label} requires confirmation`);
  if (isAborted(ctx)) return block(CONFIRMATION_FAILED);
  report("guardian-running");
  if (isAborted(ctx)) return block(CONFIRMATION_FAILED);
  let result: ReviewResult;
  try { result = deps.review ? await deps.review({ ...(bash ? { command: command ?? "" } : { tool: event.toolName, arguments: event.input }), reviewer: reviewerConfig, reviewEvidence: config.reviewEvidence, signal: ctx.signal }) : { ok: false, error: "reviewer unavailable" }; }
  catch { result = { ok: false, error: "reviewer unavailable" }; }
  if (isAborted(ctx)) { report("blocked", "Cancelled"); return block(CONFIRMATION_FAILED); }
  if (!result.ok) {
    if (result.cancelled) {
      report("blocked", "Cancelled");
      return block("Review cancelled");
    }
    return confirm(`Automatic review failed: ${result.error}`);
  }
  const { decision, reason } = result.verdict;
  if (decision === "revise") {
    report("revision-requested");
    return confirm(`Reviewer requested a revision: ${reason}\nConstraint: ${result.verdict.constraint}\nSource: ${result.verdict.source}\nApprove the original action once?`);
  }
  if (decision === "ask_user") return confirm(`Reviewer needs user approval: ${reason}`);
  report("approved");
  return isAborted(ctx) ? block(CONFIRMATION_FAILED) : undefined;
}

export default function autoApproval(pi: ExtensionAPI, verifiedVersions?: readonly string[]): void {
  const reviewerState = createReviewerState();
  const controllers = new Set<AbortController>();
  const cancelPending = () => { for (const controller of controllers) controller.abort(); };
  const globalDir = globalConfigDir();
  const display = createReviewDisplay(pi, VERSION, verifiedVersions);
  const permissions = createPermissionsController(globalDir, cancelPending, (ctx) => display.reset(ctx));
  let approvalDialogOpened = false;
  let historyWarned = false;
  const noticedFiles = new Set<string>();
  let callId = 0;
  pi.registerCommand("permissions", { description: "Configure tool protection and review mode", handler: (args, ctx) => permissions.menu(args, ctx) });
  pi.on("tool_call", async (event, ctx) => {
    const controller = new AbortController();
    controllers.add(controller);
    const signal = AbortSignal.any([controller.signal, ...(ctx.signal ? [ctx.signal] : [])]);
    const widgetKey = `auto-approval:${++callId}`;
    const callToolId = event.toolCallId ?? widgetKey;
    const displayGeneration = display.generation();
    const adapted: GateContext = { cwd: ctx.cwd, hasUI: ctx.hasUI, signal, isProjectTrusted: () => ctx.isProjectTrusted(), ui: {
      confirm: async (title, message, opts) => {
        if (approvalDialogOpened) throw new Error("confirmation already in progress");
        approvalDialogOpened = true;
        try { return await ctx.ui.confirm(title, message, opts); } finally { approvalDialogOpened = false; }
      },
      notify: (message, type) => ctx.ui.notify(message, type),
    } };
    const choices = permissions.snapshot();
    const snapshot = snapshotGate(adapted, choices, (cwd) => loadConfig(cwd, globalDir));
    permissions.refreshFooter(ctx, snapshot);
    const finalize = (outcome: GateOutcome): void => {
      recordGateOutcome(
        event,
        outcome,
        (entry) => recordHistory(ctx.cwd, entry),
        (message) => {
          if (historyWarned) return;
          historyWarned = true;
          safeWarn(adapted, message);
        },
      );
    };
    let lastReport: GateReport | undefined;
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<GateOutcome>((resolve) => {
      abortListener = () => {
        if (lastReport) display.show(ctx, lastReport.ui, { ...lastReport, state: "blocked", detail: "Cancelled", toolCallId: callToolId }, widgetKey, displayGeneration);
        resolve({ kind: "decided", decision: block(CONFIRMATION_FAILED), log: snapshot.settings.enabled });
      };
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) abortListener();
    });
    const pending = gateToolCall(
      event,
      adapted,
      snapshot,
      {
        reviewer: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        review: createPiReviewer(ctx as unknown as ReviewContext, reviewerState),
        status: (report) => {
          lastReport = report;
          display.show(ctx, report.ui, { ...report, toolCallId: callToolId }, widgetKey, displayGeneration);
        },
      },
      choices,
      noticedFiles,
    );
    try {
      const outcome = await Promise.race([pending, aborted]);
      finalize(outcome);
      return outcome.kind === "decided" ? outcome.decision : undefined;
    }
    finally { if (abortListener) signal.removeEventListener("abort", abortListener); controllers.delete(controller); void pending.catch(() => {}); }
  });
  pi.on("tool_execution_end", (event) => { if (event.toolName === "bash") display.dropInvalidator(event.toolCallId); });
  pi.on("session_start", (_event, ctx) => {
    cancelPending();
    noticedFiles.clear();
    const seeded = ensureGlobalConfig(globalDir);
    if ("error" in seeded) ctx.ui.notify(`Could not create default config ${join(globalDir, CONFIG_FILENAME)}: ${seeded.error}`, "warning");
    permissions.reset(ctx);
    permissions.refreshFooter(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => { permissions.close(); cancelPending(); display.shutdown(ctx); });
}
