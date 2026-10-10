import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Context, Model, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import type { Api } from "@earendil-works/pi-ai";
import type { ConfigResult, ReviewerConfig, Rule } from "./config.ts";
import { loadConfig, loadTrustedGroups } from "./config.ts";
import { isTrusted, matchRule } from "./gates.ts";
import { applyTruncation, buildReviewPrompt, buildSystemPrompt, collectEvidence, parseVerdict } from "./review.ts";
import type { ReviewRequest, Verdict } from "./review.ts";

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
  readonly toolCallId: string | undefined;
  readonly reviewer: ReviewerConfig;
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
  readonly sessionManager: { getBranch(): readonly unknown[] };
  readonly modelRegistry: {
    find(provider: string, modelId: string): Model<Api> | undefined;
    streamSimple(
      model: Model<Api>,
      context: Context,
      options?: ModelsSimpleStreamOptions,
    ): { result(): Promise<AssistantMessage> };
  };
}

export function createPiReviewer(ctx: ReviewContext): Reviewer {
  return async (input) => {
    try {
      const model = input.reviewer.model
        ? ctx.modelRegistry.find(input.reviewer.model.provider, input.reviewer.model.id)
        : ctx.model;
      if (!model)
        return {
          ok: false,
          error: `review model not found: ${input.reviewer.model ? `${input.reviewer.model.provider}/${input.reviewer.model.id}` : "the active model"}`,
        };
      const evidence = collectEvidence(ctx.sessionManager.getBranch(), input.toolCallId);
      const request: ReviewRequest = {
        tool: "bash",
        command: input.command,
        cwd: ctx.cwd,
        gate: input.rule.label,
        group: input.rule.group ?? null,
      };
      const signal = AbortSignal.any([
        AbortSignal.timeout(input.reviewer.timeoutMs),
        ...(input.signal ? [input.signal] : []),
      ]);
      if (signal.aborted) return { ok: false, error: "review timed out or was cancelled" };
      const pending = ctx.modelRegistry
        .streamSimple(
          model,
          {
            systemPrompt: buildSystemPrompt(input.reviewer.extraInstructions),
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: buildReviewPrompt(evidence, request) }],
                timestamp: Date.now(),
              },
            ],
          },
          { reasoning: input.reviewer.reasoningEffort, signal },
        )
        .result();
      let abortListener: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        abortListener = () => reject(new Error("review timed out or was cancelled"));
        signal.addEventListener("abort", abortListener, { once: true });
      });
      let msg: AssistantMessage;
      try {
        msg = await Promise.race([pending, aborted]);
      } finally {
        if (abortListener) signal.removeEventListener("abort", abortListener);
        void pending.catch(() => {});
      }
      if (signal.aborted || msg.stopReason === "aborted")
        return { ok: false, error: "review timed out or was cancelled" };
      if (msg.stopReason === "error") return { ok: false, error: msg.errorMessage ?? "reviewer request failed" };
      if (msg.stopReason !== "stop") return { ok: false, error: "reviewer did not finish normally" };
      const text = msg.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      const parsed = parseVerdict(text);
      return parsed.ok ? { ok: true, verdict: applyTruncation(parsed.verdict, evidence) } : parsed;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
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
          toolCallId: event.toolCallId,
          reviewer: config.reviewer,
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
      review: createPiReviewer(ctx as unknown as ReviewContext),
      status: (state, label) => {
        if (event.toolName === "bash") status(state, label);
      },
    });
  });
}
