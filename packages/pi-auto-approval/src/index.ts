import { getAgentDir, VERSION } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ConfigResult, Rule, SessionChoices } from "./config.ts";
import { loadConfig } from "./config.ts";
import { isSuspiciousAllow, matchRule } from "./gates.ts";
import { createPermissionsController } from "./permissions.ts";
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
  readonly matcher?: (command: string, rules: readonly Rule[], projectTrusted: boolean) => Rule | undefined;
  readonly status?: StatusReporter;
  readonly reviewer?: string;
  readonly review?: Reviewer;
}
export type GateStatus = ReviewState;
export type GateDecision = { block: true; reason: string } | undefined;
const CONFIRMATION_FAILED = "auto-approval: confirmation failed";
const block = (reason: string): { block: true; reason: string } => ({ block: true, reason });
function bashCommandOf(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const { command } = input as { command?: unknown };
  return typeof command === "string" ? command : undefined;
}
function safeNotify(ctx: GateContext, message: string): void { try { ctx.ui.notify(message); } catch {} }
function isAborted(ctx: GateContext): boolean { return ctx.signal?.aborted === true; }
export async function handleToolCall(event: { toolName: string; input: unknown; toolCallId?: string }, ctx: GateContext, load: ConfigLoader, deps: GateDeps = {}, choices: SessionChoices = {}): Promise<GateDecision> {
  if (event.toolName !== "bash") return undefined;
  if (isAborted(ctx)) return block(CONFIRMATION_FAILED);
  const command = bashCommandOf(event.input);
  if (command === undefined) return block("auto-approval: invalid bash input");
  if (choices.enabled === false) return isAborted(ctx) ? block(CONFIRMATION_FAILED) : undefined;
  let config: ConfigResult;
  try { config = load(ctx.cwd); } catch { return block("auto-approval: config load failed"); }
  if (!config.ok) return block(`auto-approval: invalid config - ${config.error}. Fix it to run bash.`);
  const enabled = choices.enabled ?? config.enabled;
  const mode = choices.reviewMode ?? config.reviewMode;
  if (!enabled) return isAborted(ctx) ? block(CONFIRMATION_FAILED) : undefined;
  let projectTrusted = false;
  try { projectTrusted = ctx.isProjectTrusted(); } catch {}
  const ignored = !projectTrusted ? config.rules.filter((r) => r.scope === "project" && r.level === "allow" && r.pattern.test(command)) : [];
  const ignoredNote = ignored.length ? `Ignored project allow rule(s) from ${[...new Set(ignored.map((r) => r.source))].join(", ")} because the project is untrusted.` : "";
  if (ignoredNote) safeNotify(ctx, ignoredNote);
  let rule: Rule | undefined;
  try { rule = (deps.matcher ?? matchRule)(command, config.rules, projectTrusted); } catch { return block("auto-approval: matcher error"); }
  if (isAborted(ctx)) return block(CONFIRMATION_FAILED);
  const label = rule?.label ?? "Unmatched Bash command";
  const reviewer = config.reviewer.model ? `${config.reviewer.model.provider}/${config.reviewer.model.id}` : deps.reviewer;
  const report = (state: ReviewState, detail?: string) => {
    if (!ctx.hasUI || !config.ui.status || !deps.status || isAborted(ctx)) return;
    try { deps.status({ state, label, ...(rule?.source ? { source: rule.source } : {}), ...(state === "guardian-running" && reviewer ? { reviewer } : {}), ...(detail ? { detail } : {}), ui: config.ui }); } catch {}
  };
  const attribution = rule ? `(${rule.label}, ${rule.source})` : "";
  const confirm = async (reason: string, message?: string): Promise<GateDecision> => {
    if (!ctx.hasUI) return block(`${reason}${ignoredNote ? ` ${ignoredNote}` : ""}`);
    if (isAborted(ctx)) return block(CONFIRMATION_FAILED);
    report("approval-required");
    if (isAborted(ctx)) return block(CONFIRMATION_FAILED);
    try {
      const approved = await ctx.ui.confirm(`Approve command?${rule ? ` [${rule.label}]` : ""}`, `${reason}${message ? `\n${message}` : ""}\n\n${command}`, { signal: ctx.signal });
      if (isAborted(ctx) || approved !== true) { report("blocked", isAborted(ctx) ? "Cancelled" : undefined); return block(`${reason}${isAborted(ctx) ? " (review cancelled)" : " (user declined)"}${ignoredNote ? ` ${ignoredNote}` : ""}`); }
      report("approved");
      return isAborted(ctx) ? block(CONFIRMATION_FAILED) : undefined;
    } catch { report("blocked"); return block(`${reason} (confirmation failed)${ignoredNote ? ` ${ignoredNote}` : ""}`); }
  };
  if (rule?.level === "deny") { report("blocked"); return block(`Blocked by auto-approval ${attribution}${rule.message ? `: ${rule.message}` : ""}${ignoredNote ? ` ${ignoredNote}` : ""}`); }
  if (rule?.level === "ask") return confirm(`Requires confirmation ${attribution}`, rule.message);
  if (rule?.level === "allow") {
    if (isSuspiciousAllow(command)) return confirm(`Combined or nested command requires confirmation ${attribution}`, rule.message);
    safeNotify(ctx, `Allowed by rule (${rule.label}, ${rule.source})`);
    report("approved");
    return isAborted(ctx) ? block(CONFIRMATION_FAILED) : undefined;
  }
  if (mode === "manual") return confirm("Unmatched Bash command requires confirmation");
  if (isAborted(ctx)) return block(CONFIRMATION_FAILED);
  report("guardian-running");
  if (isAborted(ctx)) return block(CONFIRMATION_FAILED);
  let result: ReviewResult;
  try { result = deps.review ? await deps.review({ command, reviewer: config.reviewer, reviewEvidence: config.reviewEvidence, signal: ctx.signal }) : { ok: false, error: "reviewer unavailable" }; }
  catch { result = { ok: false, error: "reviewer unavailable" }; }
  if (isAborted(ctx)) { report("blocked", "Cancelled"); return block(CONFIRMATION_FAILED); }
  if (!result.ok) {
    if (result.cancelled) { report("blocked", "Cancelled"); return block(`Review cancelled${ignoredNote ? ` ${ignoredNote}` : ""}`); }
    return confirm(`Automatic review failed: ${result.error}`);
  }
  const { decision, reason } = result.verdict;
  if (decision === "revise") { report("revision-requested"); return block(`Reviewer requested a revision: ${reason}${ignoredNote ? ` ${ignoredNote}` : ""}`); }
  if (decision === "ask_user") return confirm(`Reviewer needs user approval: ${reason}`);
  report("approved");
  return isAborted(ctx) ? block(CONFIRMATION_FAILED) : undefined;
}

export default function autoApproval(pi: ExtensionAPI, verifiedVersions?: readonly string[]): void {
  const reviewerState = createReviewerState();
  const controllers = new Set<AbortController>();
  const cancelPending = () => { for (const controller of controllers) controller.abort(); };
  const permissions = createPermissionsController(getAgentDir(), cancelPending);
  const display = createReviewDisplay(pi, VERSION, verifiedVersions);
  let approvalDialogOpened = false;
  let callId = 0;
  pi.registerCommand("permissions", { description: "Configure Bash protection and review mode", handler: (args, ctx) => permissions.menu(args, ctx) });
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;
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
    const pending = handleToolCall(event, adapted, (cwd) => loadConfig(cwd, getAgentDir()), {
      reviewer: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
      review: createPiReviewer(ctx as unknown as ReviewContext, reviewerState),
      status: (report) => {
        lastReport = report;
        display.show(ctx, report.ui, { ...report, toolCallId: callToolId }, widgetKey, displayGeneration);
      },
    }, permissions.snapshot());
    try { return await Promise.race([pending, aborted]); }
    finally { if (abortListener) signal.removeEventListener("abort", abortListener); controllers.delete(controller); void pending.catch(() => {}); }
  });
  pi.on("tool_execution_end", (event) => { if (event.toolName === "bash") display.dropInvalidator(event.toolCallId); });
  pi.on("session_start", (_event, ctx) => { cancelPending(); permissions.reset(ctx); display.reset(ctx); permissions.refreshFooter(ctx); });
  pi.on("session_shutdown", (_event, ctx) => { cancelPending(); display.shutdown(ctx); });
}
