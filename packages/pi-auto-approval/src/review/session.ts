import type { AssistantMessage, Context, Message, Model, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import type { Api } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import type { ReviewEvidenceConfig, ReviewerConfig } from "../config.ts";
import { loadProjectInstructions } from "../config.ts";
import { BUDGET_EXCEEDED_ERROR, buildReviewPrompt, buildSystemPrompt, collectEvidence, contextBudget, estimateTokens, evidencePrefixMatches, parseVerdict, promptTokens, reviewerFingerprint } from "./protocol.ts";
import type { EvidenceRecord, ReviewRequest, Verdict } from "./protocol.ts";

export type ReviewResult =
  | { readonly ok: true; readonly verdict: Verdict }
  | { readonly ok: false; readonly error: string; readonly cancelled?: true };
export interface ReviewInput {
  readonly command?: string;
  readonly tool?: string;
  readonly arguments?: unknown;
  readonly reviewer: ReviewerConfig;
  readonly reviewEvidence: ReviewEvidenceConfig;
  readonly signal: AbortSignal | undefined;
}
export type Reviewer = (input: ReviewInput) => Promise<ReviewResult>;

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
      return { ok: false, error: "review timed out or was cancelled", ...(input.signal?.aborted ? { cancelled: true as const } : {}) };
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
    const tool = input.tool ?? "bash";
    const gate = tool === "bash" ? "Unmatched Bash command" : `Unmatched ${tool} tool call`;
    const request: ReviewRequest = { tool, command: input.command, arguments: input.arguments, cwd: ctx.cwd, gate, group: null };
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
    if (signal.aborted || msg.stopReason === "aborted") throw Object.assign(new Error("review timed out or was cancelled"), { cancelled: input.signal?.aborted === true || msg.stopReason === "aborted" });
    if (msg.stopReason === "error") throw new Error(msg.errorMessage ?? "reviewer request failed");
    if (msg.stopReason !== "stop") throw new Error("reviewer did not finish normally");
    const parsed = parseVerdict(msg.content.filter((part) => part.type === "text").map((part) => part.text).join(""));
    if (!parsed.ok) throw new Error(parsed.error);
    if (signal.aborted) throw new Error("review timed out or was cancelled");
    state.lineage = { fingerprint, sessionId, records, messages: [...messages, msg], lastPromptTokens: promptTokens(msg.usage) };
    return parsed;
  } catch (error) {
    discard();
    return { ok: false, error: error instanceof Error ? error.message : String(error), ...((input.signal?.aborted || (error && typeof error === "object" && "cancelled" in error && error.cancelled === true)) ? { cancelled: true as const } : {}) };
  }
}

export function createPiReviewer(ctx: ReviewContext, state: ReviewerState): Reviewer {
  return (input) => {
    const next = state.queue.then(() => reviewOnce(ctx, state, input));
    state.queue = next;
    return next;
  };
}
