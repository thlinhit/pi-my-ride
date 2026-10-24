import { join } from "node:path";
import { VERSION } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ConfigResult, PermissionRule, SessionChoices } from "./config.ts";
import { CONFIG_FILENAME, ensureGlobalConfig, globalConfigDir, loadConfig } from "./config.ts";
import { analyzeShell } from "./shell.ts";
import { matchPermission, matchPermissionExact } from "./rules.ts";
import { createPermissionsController } from "./permissions.ts";
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
export type ConfigLoader = (cwd: string) => ConfigResult;
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
const NOT_GATED = Symbol("not gated");
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
function protectionOff(cwd: string, load: ConfigLoader, choices: SessionChoices): boolean {
  if (choices.enabled === false) return true;
  try {
    const config = load(cwd);
    return config.ok && (choices.enabled ?? config.enabled) === false;
  } catch {
    return false;
  }
}
function recordGateOutcome(event: { toolName: string; input: unknown }, cwd: string, load: ConfigLoader, choices: SessionChoices, decision: GateDecision, record: (entry: HistoryEntry) => HistoryResult, warn: (message: string) => void): void {
  if (protectionOff(cwd, load, choices)) return;
  let result: HistoryResult;
  try { result = record({ tool: event.toolName, command: historyCommandOf(event.toolName, event.input), decision: decision ? "blocked" : "approved" }); }
  catch (error) { result = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  if (!result.ok) warn(`Could not record auto-approval history: ${result.error}`);
}
function safeWarn(ctx: GateContext, message: string): void { try { ctx.ui.notify(message, "warning"); } catch {} }

export async function handleToolCall(event: { toolName: string; input: unknown; toolCallId?: string }, ctx: GateContext, load: ConfigLoader, deps: GateDeps = {}, choices: SessionChoices = {}): Promise<GateDecision> {
  const decision = await gateToolCall(event, ctx, load, deps, choices);
  if (decision === NOT_GATED) return undefined;
  if (deps.history) recordGateOutcome(event, ctx.cwd, load, choices, decision, deps.history, (message) => safeWarn(ctx, message));
  return decision;
}

async function gateToolCall(event: { toolName: string; input: unknown; toolCallId?: string }, ctx: GateContext, load: ConfigLoader, deps: GateDeps, choices: SessionChoices): Promise<GateDecision | typeof NOT_GATED> {
  if (isAborted(ctx)) return block(CONFIRMATION_FAILED);
  const bash = event.toolName === "bash";
  const command = bashCommandOf(event.input);
  if (bash && command === undefined) return block("auto-approval: invalid bash input");
  if (choices.enabled === false) return isAborted(ctx) ? block(CONFIRMATION_FAILED) : NOT_GATED;
  let config: ConfigResult;
  try { config = load(ctx.cwd); } catch { return block("auto-approval: config load failed"); }
  if (!config.ok) return block(`auto-approval: invalid config - ${config.error}. Fix it to run tools.`);
  const enabled = choices.enabled ?? config.enabled;
  const mode = choices.reviewMode ?? config.reviewMode;
  if (!enabled) return isAborted(ctx) ? block(CONFIRMATION_FAILED) : NOT_GATED;
  let projectTrusted = false;
  try { projectTrusted = ctx.isProjectTrusted(); } catch {}
  const analysis = bash ? analyzeShell(command!) : undefined;
  const matcher = deps.matcher ?? (bash ? matchPermissionExact : matchPermission);
  let ignored: PermissionRule[] = [];
  let rule: PermissionRule | undefined;
  try {
    if (!projectTrusted) ignored = config.rules.filter((candidate) => candidate.scope === "project" && candidate.level === "allow" && [event, ...(analysis?.supported ? analysis.components.map(component => ({ toolName: "bash", input: { command: component.command } })) : [])].some(call => matcher(call, ctx.cwd, [candidate], true) !== undefined));
    rule = matcher({ toolName: event.toolName, input: event.input }, ctx.cwd, config.rules, projectTrusted);
    if (bash && !analysis?.supported) rule = matchPermission(event, ctx.cwd, config.rules.filter(candidate => candidate.level !== "allow"), projectTrusted) ?? rule;
  } catch { return block("auto-approval: matcher error"); }
  const ignoredNote = ignored.length ? `Ignored project allow rule(s) from ${[...new Set(ignored.map((r) => r.source))].join(", ")} because the project is untrusted.` : "";
  if (ignoredNote) safeNotify(ctx, ignoredNote);
  if (isAborted(ctx)) return block(CONFIRMATION_FAILED);
  const label = rule?.label ?? (bash ? "Unmatched Bash command" : `Unmatched ${event.toolName} call`);
  const reviewer = config.reviewer.model ? `${config.reviewer.model.provider}/${config.reviewer.model.id}` : deps.reviewer;
  const report = (state: ReviewState, detail?: string) => {
    if (!ctx.hasUI || !(choices.debug ?? config.debug) || !config.ui.status || !deps.status || isAborted(ctx)) return;
    try { deps.status({ state, label, ...(rule?.source ? { source: rule.source } : {}), ...(state === "guardian-running" && reviewer ? { reviewer } : {}), ...(detail ? { detail } : {}), ui: config.ui }); } catch {}
  };
  const attribution = rule ? `(${rule.label}, ${rule.source})` : "";
  const confirm = async (reason: string): Promise<GateDecision> => {
    if (!ctx.hasUI) return block(`${reason}${ignoredNote ? ` ${ignoredNote}` : ""}`);
    if (isAborted(ctx)) return block(CONFIRMATION_FAILED);
    report("approval-required");
    if (isAborted(ctx)) return block(CONFIRMATION_FAILED);
    try {
      const approved = await ctx.ui.confirm(`Approve command?${rule ? ` [${rule.label}]` : ""}`, `${reason}\n\n${bash ? command : callExcerpt(event.toolName, event.input)}`, { signal: ctx.signal });
      if (isAborted(ctx) || approved !== true) { report("blocked", isAborted(ctx) ? "Cancelled" : undefined); return block(`${reason}${isAborted(ctx) ? " (review cancelled)" : " (user declined)"}${ignoredNote ? ` ${ignoredNote}` : ""}`); }
      report("approved");
      return isAborted(ctx) ? block(CONFIRMATION_FAILED) : undefined;
    } catch { report("blocked"); return block(`${reason} (confirmation failed)${ignoredNote ? ` ${ignoredNote}` : ""}`); }
  };
  if (rule?.level === "deny") { report("blocked"); return block(`Blocked by auto-approval ${attribution}${ignoredNote ? ` ${ignoredNote}` : ""}`); }
  if (analysis && !analysis.supported && !analysis.reviewable) return confirm(`${analysis.reason} requires confirmation`);
  if (bash && analysis?.supported) {
    const reasons: string[] = rule?.level === "ask" ? [`Requires confirmation ${attribution}`] : [];
    let componentRules: (PermissionRule | undefined)[];
    try {
      componentRules = analysis.components.map(component => matcher({ toolName: "bash", input: { command: component.command } }, ctx.cwd, config.rules, projectTrusted));
    } catch { return block("auto-approval: matcher error"); }
    const denied = componentRules.find(candidate => candidate?.level === "deny");
    if (denied) { report("blocked"); return block(`Blocked by auto-approval (${denied.label}, ${denied.source})${ignoredNote ? ` ${ignoredNote}` : ""}`); }
    for (let index = 0; index < analysis.components.length; index++) {
      if (isAborted(ctx)) return block(CONFIRMATION_FAILED);
      const component = analysis.components[index]!;
      const componentRule = componentRules[index];
      if (componentRule?.level === "allow") {
        if (choices.debug ?? config.debug) safeNotify(ctx, `Allowed by rule (${componentRule.label}, ${componentRule.source})`);
        continue;
      }
      if (componentRule?.level === "ask") { reasons.push(`Requires confirmation (${componentRule.label}, ${componentRule.source})`); continue; }
      if (mode === "manual") { reasons.push(`${label} requires confirmation`); continue; }
      report("guardian-running");
      if (isAborted(ctx)) return block(CONFIRMATION_FAILED);
      let result: ReviewResult;
      try {
        result = deps.review ? await deps.review({ command: component.command, component: { originalCommand: command!, index: index + 1, count: analysis.components.length, start: component.start, end: component.end, context: component.context }, reviewer: config.reviewer, reviewEvidence: config.reviewEvidence, signal: ctx.signal }) : { ok: false, error: "reviewer unavailable" };
      } catch { result = { ok: false, error: "reviewer unavailable" }; }
      if (isAborted(ctx)) { report("blocked", "Cancelled"); return block(CONFIRMATION_FAILED); }
      if (!result.ok) {
        if (result.cancelled) { report("blocked", "Cancelled"); return block(`Review cancelled${ignoredNote ? ` ${ignoredNote}` : ""}`); }
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
    if (choices.debug ?? config.debug) safeNotify(ctx, `Allowed by rule (${rule.label}, ${rule.source})`);
    report("approved");
    return isAborted(ctx) ? block(CONFIRMATION_FAILED) : undefined;
  }
  if (mode === "manual") return confirm(`${label} requires confirmation`);
  if (isAborted(ctx)) return block(CONFIRMATION_FAILED);
  report("guardian-running");
  if (isAborted(ctx)) return block(CONFIRMATION_FAILED);
  let result: ReviewResult;
  try { result = deps.review ? await deps.review({ ...(bash ? { command: command ?? "" } : { tool: event.toolName, arguments: event.input }), reviewer: config.reviewer, reviewEvidence: config.reviewEvidence, signal: ctx.signal }) : { ok: false, error: "reviewer unavailable" }; }
  catch { result = { ok: false, error: "reviewer unavailable" }; }
  if (isAborted(ctx)) { report("blocked", "Cancelled"); return block(CONFIRMATION_FAILED); }
  if (!result.ok) {
    if (result.cancelled) { report("blocked", "Cancelled"); return block(`Review cancelled${ignoredNote ? ` ${ignoredNote}` : ""}`); }
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
    permissions.refreshFooter(ctx);
    const choices = permissions.snapshot();
    const load = (cwd: string) => loadConfig(cwd, globalDir);
    let recorded = false;
    const finalize = (decision: GateDecision): void => {
      if (recorded) return;
      recorded = true;
      recordGateOutcome(event, ctx.cwd, load, choices, decision, (entry) => recordHistory(ctx.cwd, entry), (message) => {
        if (historyWarned) return;
        historyWarned = true;
        safeWarn(adapted, message);
      });
    };
    let lastReport: GateReport | undefined;
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<GateDecision>((resolve) => {
      abortListener = () => {
        if (lastReport) display.show(ctx, lastReport.ui, { ...lastReport, state: "blocked", detail: "Cancelled", toolCallId: callToolId }, widgetKey, displayGeneration);
        resolve(block(CONFIRMATION_FAILED));
      };
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) abortListener();
    });
    const pending = handleToolCall(event, adapted, load, {
      reviewer: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
      review: createPiReviewer(ctx as unknown as ReviewContext, reviewerState),
      status: (report) => {
        lastReport = report;
        display.show(ctx, report.ui, { ...report, toolCallId: callToolId }, widgetKey, displayGeneration);
      },
    }, choices);
    try {
      const decision = await Promise.race([pending, aborted]);
      finalize(decision);
      return decision;
    }
    finally { if (abortListener) signal.removeEventListener("abort", abortListener); controllers.delete(controller); void pending.catch(() => {}); }
  });
  pi.on("tool_execution_end", (event) => { if (event.toolName === "bash") display.dropInvalidator(event.toolCallId); });
  pi.on("session_start", (_event, ctx) => {
    cancelPending();
    const seeded = ensureGlobalConfig(globalDir);
    if ("error" in seeded) ctx.ui.notify(`Could not create default config ${join(globalDir, CONFIG_FILENAME)}: ${seeded.error}`, "warning");
    permissions.reset(ctx);
    permissions.refreshFooter(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => { cancelPending(); display.shutdown(ctx); });
}
