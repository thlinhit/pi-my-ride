import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Context, Message, Model, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import type { Api } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import type { ConfigResult, ReviewEvidenceConfig, ReviewerConfig, Rule } from "./config.ts";
import { loadConfig, loadProjectInstructions, loadTrustedGroups } from "./config.ts";
import { isTrusted, matchRule } from "./gates.ts";
import { BUDGET_EXCEEDED_ERROR, buildReviewPrompt, buildSystemPrompt, collectEvidence, contextBudget, estimateTokens, evidencePrefixMatches, parseVerdict, promptTokens, reviewerFingerprint } from "./review.ts";
import type { EvidenceRecord, ReviewRequest, Verdict } from "./review.ts";

export interface GateContext {
  readonly cwd: string;
  readonly hasUI: boolean;
  readonly signal: AbortSignal | undefined;
  readonly ui: { confirm(title: string, message: string, opts?: { signal?: AbortSignal }): Promise<boolean> };
}

export type ConfigLoader = (cwd: string) => ConfigResult;
export type GateStatus = "reviewing" | "approved" | "blocked";
export type StatusReporter = (state: GateStatus, label: string) => void;
export type ReviewResult =
  | { readonly ok: true; readonly verdict: Verdict }
  | { readonly ok: false; readonly error: string };
export interface ReviewInput {
  readonly command: string;
  readonly rule: Rule;
  readonly reviewer: ReviewerConfig;
  readonly reviewEvidence: ReviewEvidenceConfig;
  readonly signal: AbortSignal | undefined;
}
export type Reviewer = (input: ReviewInput) => Promise<ReviewResult>;
export interface GateDeps {
  readonly matcher?: (command: string, rules: readonly Rule[]) => Rule | undefined;
  readonly trusted?: (cwd: string) => ReadonlySet<string>;
  readonly status?: StatusReporter;
  readonly review?: Reviewer;
}

export interface ReviewContext {
  readonly cwd: string;
  readonly model: Model<Api> | undefined;
  isProjectTrusted(): boolean;
  readonly sessionManager: {
    getSessionId(): string;
    buildSessionProjection(): { readonly entries: readonly { readonly sourceEntry: unknown; readonly messages: readonly unknown[] }[] };
  };
  readonly modelRegistry: {
    find(provider: string, modelId: string): Model<Api> | undefined;
    streamSimple(
      model: Model<Api>,
      context: Context,
      options?: ModelsSimpleStreamOptions,
    ): { result(): Promise<AssistantMessage> };
  };
}

interface Lineage {
  readonly fingerprint: string;
  readonly sessionId: string;
  readonly records: readonly EvidenceRecord[];
  readonly messages: readonly Message[];
  readonly lastPromptTokens: number;
}
export interface ReviewerState {
  lineage: Lineage | undefined;
  queue: Promise<unknown>;
}
export function createReviewerState(): ReviewerState {
  return { lineage: undefined, queue: Promise.resolve() };
}

function adaptProjection(ctx: ReviewContext): readonly unknown[] {
  const entries: unknown[] = [];
  for (const contribution of ctx.sessionManager.buildSessionProjection().entries) {
    const source = contribution.sourceEntry;
    if (!source || typeof source !== "object") continue;
    const entry = source as { type?: unknown; id?: unknown };
    if (entry.type === "message") {
      for (const message of contribution.messages) {
        if (message && typeof message === "object" && ["user", "assistant", "toolResult"].includes((message as { role?: string }).role ?? ""))
          entries.push({ ...entry, message });
      }
    } else if ((entry.type === "compaction" || entry.type === "branch_summary") && contribution.messages.length > 0) {
      entries.push(source);
    }
  }
  return entries;
}

async function reviewOnce(ctx: ReviewContext, state: ReviewerState, input: ReviewInput): Promise<ReviewResult> {
  const discard = () => { state.lineage = undefined; };
  try {
    if (input.signal?.aborted) {
      discard();
      return { ok: false, error: "review timed out or was cancelled" };
    }
    const model = input.reviewer.model
      ? ctx.modelRegistry.find(input.reviewer.model.provider, input.reviewer.model.id)
      : ctx.model;
    if (!model) {
      discard();
      return { ok: false, error: `review model not found: ${input.reviewer.model ? `${input.reviewer.model.provider}/${input.reviewer.model.id}` : "the active model"}` };
    }
    const signal = AbortSignal.any([AbortSignal.timeout(input.reviewer.timeoutMs), ...(input.signal ? [input.signal] : [])]);
    if (signal.aborted) throw new Error("review timed out or was cancelled");
    const mainSessionId = ctx.sessionManager.getSessionId();
    const projectTrusted = ctx.isProjectTrusted();
    const projectInstructions = input.reviewEvidence.projectInstructions && projectTrusted ? loadProjectInstructions(ctx.cwd) : undefined;
    const systemPrompt = buildSystemPrompt(input.reviewer.extraInstructions, projectInstructions);
    const fingerprint = reviewerFingerprint({ mainSessionId, model: { provider: model.provider, id: model.id, api: model.api, baseUrl: model.baseUrl }, reasoningEffort: input.reviewer.reasoningEffort, systemPrompt, projectTrusted });
    const records = collectEvidence(adaptProjection(ctx));
    const budget = contextBudget(model.contextWindow);
    let base = state.lineage;
    if (base && (base.fingerprint !== fingerprint || !evidencePrefixMatches(base.records, records) || base.lastPromptTokens >= budget)) {
      discard();
      base = undefined;
    }
    const request: ReviewRequest = { tool: "bash", command: input.command, cwd: ctx.cwd, gate: input.rule.label, group: input.rule.group ?? null };
    const makeUser = (selected: readonly EvidenceRecord[], mode: "full" | "delta") => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: buildReviewPrompt(selected, request, mode) }],
      timestamp: Date.now(),
    });
    let user = makeUser(base ? records.slice(base.records.length) : records, base ? "delta" : "full");
    let messages: Message[] = base ? [...base.messages, user] : [user];
    if (base && estimateTokens(systemPrompt, messages) >= budget) {
      discard(); base = undefined; user = makeUser(records, "full"); messages = [user];
    }
    if (estimateTokens(systemPrompt, messages) >= budget) {
      discard(); return { ok: false, error: BUDGET_EXCEEDED_ERROR };
    }
    const sessionId = base?.sessionId ?? `ap-review-${randomUUID()}`;
    if (signal.aborted) throw new Error("review timed out or was cancelled");
    const pending = ctx.modelRegistry.streamSimple(model, { systemPrompt, messages }, { reasoning: input.reviewer.reasoningEffort, signal, sessionId, cacheRetention: "long" }).result();
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(new Error("review timed out or was cancelled"));
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) abortListener();
    });
    let msg: AssistantMessage;
    try { msg = await Promise.race([pending, aborted]); }
    finally { if (abortListener) signal.removeEventListener("abort", abortListener); void pending.catch(() => {}); }
    if (signal.aborted || msg.stopReason === "aborted") throw new Error("review timed out or was cancelled");
    if (msg.stopReason === "error") throw new Error(msg.errorMessage ?? "reviewer request failed");
    if (msg.stopReason !== "stop") throw new Error("reviewer did not finish normally");
    const parsed = parseVerdict(msg.content.filter((part) => part.type === "text").map((part) => part.text).join(""));
    if (!parsed.ok) throw new Error(parsed.error);
    if (signal.aborted) throw new Error("review timed out or was cancelled");
    state.lineage = { fingerprint, sessionId, records, messages: [...messages, msg], lastPromptTokens: promptTokens(msg.usage) };
    return parsed;
  } catch (error) {
    discard();
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function createPiReviewer(ctx: ReviewContext, state: ReviewerState): Reviewer {
  return (input) => {
    const next = state.queue.then(() => reviewOnce(ctx, state, input));
    state.queue = next;
    return next;
  };
}

export function createWidgetReporter(
  ui: { setWidget(key: string, content: string[] | undefined): void },
  key: string,
): StatusReporter {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (state, label) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    try {
      ui.setWidget(key, [`auto-approval: ${state} [${label}]`]);
    } catch {}
    if (state !== "reviewing") {
      timer = setTimeout(() => {
        try {
          ui.setWidget(key, undefined);
        } catch {}
        timer = undefined;
      }, 2000);
      timer.unref?.();
    }
  };
}

export type GateDecision = { block: true; reason: string } | undefined;
const CONFIRMATION_FAILED = "auto-approval: confirmation failed";
const block = (reason: string): { block: true; reason: string } => ({ block: true, reason });
const blockByRule = (rule: Rule, why: string): { block: true; reason: string } =>
  block(`Blocked by auto-approval (${rule.label}): ${why}`);
function bashCommandOf(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const { command } = input as { command?: unknown };
  return typeof command === "string" ? command : undefined;
}
function loadTrustedOrNone(deps: GateDeps, cwd: string): ReadonlySet<string> {
  try {
    return (deps.trusted ?? loadTrustedGroups)(cwd);
  } catch {
    return new Set();
  }
}
function isRuleTrusted(rule: Rule, trusted: ReadonlySet<string>): boolean {
  if (rule.group === undefined) return false;
  try {
    return isTrusted(rule, trusted);
  } catch {
    return false;
  }
}
async function confirmWithUser(
  rule: Rule,
  command: string,
  ctx: GateContext,
  report: (state: GateStatus) => void,
  note?: string,
): Promise<GateDecision> {
  report("reviewing");
  try {
    const approved = await ctx.ui.confirm(
      `Approve command? [${rule.label}]`,
      note ? `${note}\n\n${command}` : command,
      { signal: ctx.signal },
    );
    if (ctx.signal?.aborted) {
      report("blocked");
      return blockByRule(rule, "confirmation failed");
    }
    if (approved !== true) {
      report("blocked");
      return blockByRule(rule, "user declined");
    }
    report("approved");
    if (ctx.signal?.aborted) {
      report("blocked");
      return blockByRule(rule, "review cancelled");
    }
    return undefined;
  } catch {
    report("blocked");
    return blockByRule(rule, "confirmation failed");
  }
}

export async function handleToolCall(
  event: { toolName: string; input: unknown; toolCallId?: string },
  ctx: GateContext,
  load: ConfigLoader,
  deps: GateDeps = {},
): Promise<GateDecision> {
  if (event.toolName !== "bash") return undefined;
  if (ctx.signal?.aborted) return block(CONFIRMATION_FAILED);
  const command = bashCommandOf(event.input);
  if (command === undefined) return block("auto-approval: invalid bash input");
  let config: ConfigResult;
  try {
    config = load(ctx.cwd);
  } catch {
    return block("auto-approval: config load failed");
  }
  if (!config.ok) return block(`auto-approval: invalid config - ${config.error}. Fix it to run bash.`);
  const trusted = loadTrustedOrNone(deps, ctx.cwd);
  if (ctx.signal?.aborted) return block(CONFIRMATION_FAILED);
  let matched: Rule | undefined;
  try {
    matched = (deps.matcher ?? matchRule)(command, config.rules);
  } catch {
    return block("auto-approval: matcher error");
  }
  if (!matched) return undefined;
  const rule = matched;
  const report = (state: GateStatus) => {
    if (!ctx.hasUI || !config.ui.status || !deps.status) return;
    try {
      deps.status(state, rule.label);
    } catch {}
  };
  if (rule.level === "convention") {
    report("blocked");
    return block(rule.message ?? "");
  }
  if (isRuleTrusted(rule, trusted)) {
    if (ctx.signal?.aborted) return blockByRule(rule, "confirmation failed");
    report("approved");
    if (ctx.signal?.aborted) return blockByRule(rule, "confirmation failed");
    return undefined;
  }
  if (!config.guardian) {
    if (!ctx.hasUI) return blockByRule(rule, "no UI to confirm");
    return confirmWithUser(rule, command, ctx, report);
  }
  report("reviewing");
  let result: ReviewResult;
  try {
    result = deps.review
      ? await deps.review({
          command,
          rule,
          reviewer: config.reviewer,
          reviewEvidence: config.reviewEvidence,
          signal: ctx.signal,
        })
      : { ok: false, error: "reviewer unavailable" };
  } catch {
    result = { ok: false, error: "reviewer unavailable" };
  }
  if (ctx.signal?.aborted) {
    report("blocked");
    return blockByRule(rule, "review cancelled");
  }
  if (!result.ok) {
    if (!ctx.hasUI) {
      report("blocked");
      return blockByRule(rule, `automatic review failed: ${result.error}`);
    }
    return confirmWithUser(rule, command, ctx, report, `Automatic review failed: ${result.error}`);
  }
  const { decision, reason } = result.verdict;
  if (decision === "revise") {
    report("blocked");
    return blockByRule(rule, `guardian requested a revision: ${reason}`);
  }
  if (decision === "ask_user") {
    if (!ctx.hasUI) {
      report("blocked");
      return blockByRule(rule, `guardian needs user approval and no UI is available: ${reason}`);
    }
    return confirmWithUser(rule, command, ctx, report, `Guardian: ${reason}`);
  }
  report("approved");
  if (ctx.signal?.aborted) {
    report("blocked");
    return blockByRule(rule, "review cancelled");
  }
  return undefined;
}

export default function autoApproval(pi: ExtensionAPI): void {
  const reviewerState = createReviewerState();
  let approvalDialogOpened = false;
  let callId = 0;
  pi.on("tool_call", async (event, ctx) => {
    const adapted: GateContext = {
      cwd: ctx.cwd,
      hasUI: ctx.hasUI,
      signal: ctx.signal,
      ui: {
        confirm: async (title, message, opts) => {
          if (approvalDialogOpened) throw new Error("confirmation already in progress");
          approvalDialogOpened = true;
          try {
            return await ctx.ui.confirm(title, message, opts);
          } finally {
            approvalDialogOpened = false;
          }
        },
      },
    };
    const status = createWidgetReporter(ctx.ui, `auto-approval:${++callId}`);
    return handleToolCall(event, adapted, (cwd) => loadConfig(cwd, getAgentDir()), {
      review: createPiReviewer(ctx as unknown as ReviewContext, reviewerState),
      status: (state, label) => {
        if (event.toolName === "bash") status(state, label);
      },
    });
  });
}
