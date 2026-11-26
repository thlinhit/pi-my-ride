import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, Context, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { DEFAULT_REVIEW_EVIDENCE, DEFAULT_REVIEWER, parseConfig } from "../../src/config.ts";
import { handleToolCall } from "../../src/index.ts";
import { contextBudget, estimateTokens } from "../../src/review/protocol.ts";
import { createPiReviewer, createReviewerState, type ReviewContext } from "../../src/review/session.ts";

const input = {
  command: "first request",
  reviewer: DEFAULT_REVIEWER,
  reviewEvidence: DEFAULT_REVIEW_EVIDENCE,
  signal: undefined,
};
const approval = { decision: "approve", tier: "none", reason: "No policy restriction applies." } as const;
const tierInvalid = '{"decision":"block","tier":"allow","reason":"Invalid pairing."}';
const malformed = "not a JSON verdict";

function reply(
  text: string,
  stopReason: AssistantMessage["stopReason"] = "stop",
  errorMessage?: string,
): AssistantMessage {
  return { role: "assistant", stopReason, content: [{ type: "text", text }], errorMessage } as AssistantMessage;
}

function stubReviewer(...replies: Array<AssistantMessage | (() => Promise<AssistantMessage>)>) {
  const calls: { messages: Context["messages"]; systemPrompt: string; options?: ModelsSimpleStreamOptions }[] = [];
  const state = createReviewerState();
  const ctx: ReviewContext = {
    cwd: "/repo",
    model: {
      provider: "p",
      id: "m",
      api: "openai-responses",
      baseUrl: "",
      contextWindow: 128_000,
    } as ReviewContext["model"],
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "main", buildSessionProjection: () => ({ entries: [] }) },
    modelRegistry: {
      find: () => undefined,
      streamSimple: (_model, { messages, systemPrompt }, options) => {
        calls.push({ messages: structuredClone(messages), systemPrompt: systemPrompt ?? "", options });
        const next = replies.shift();
        assert.ok(next, "unexpected provider call");
        return { result: async () => (typeof next === "function" ? next() : next) };
      },
    },
  };
  return { calls, state, review: createPiReviewer(ctx, state) };
}

test("retries a tier-invalid verdict in the same reviewer conversation", async () => {
  const bad = reply(tierInvalid);
  const { calls, review } = stubReviewer(bad, reply(JSON.stringify(approval)));
  assert.deepEqual(await review(input), { ok: true, verdict: approval });
  assert.equal(calls.length, 2);
  assert.ok(calls[0]?.options?.sessionId);
  assert.equal(calls[1]?.options?.sessionId, calls[0]?.options?.sessionId);
  assert.deepEqual(calls[1]?.messages.slice(0, -1), [...calls[0]!.messages, bad]);
  const correction = calls[1]?.messages.at(-1);
  assert.equal(correction?.role, "user");
  const prompt = JSON.stringify(correction?.content);
  assert.match(prompt, /invalid tier/);
  assert.match(prompt, /approve.*allow.*user_intent.*none/);
  assert.match(prompt, /block.*hard_deny.*soft_deny/);
  assert.match(prompt, /revise.*none.*constraint.*source/);
  assert.match(prompt, /reason/);
});

test("retries unparseable text without replaying the correction in later reviews", async () => {
  const good = reply(JSON.stringify(approval));
  const { calls, review } = stubReviewer(good, reply(malformed), good, good);
  assert.equal((await review({ ...input, command: "seeded request" })).ok, true);
  assert.deepEqual(await review(input), { ok: true, verdict: approval });
  assert.equal(calls.length, 3);
  assert.equal(calls[2]?.options?.signal, calls[1]?.options?.signal);
  assert.match(JSON.stringify(calls[2]?.messages.at(-1)), /reviewer returned no JSON object/);

  assert.equal((await review({ ...input, command: "next request" })).ok, true);
  assert.deepEqual(calls[3]?.messages.slice(0, -1), [...calls[1]!.messages, good]);
  assert.match(JSON.stringify(calls[3]?.messages.at(-1)), /next request/);
  assert.notEqual(calls[3]?.options?.sessionId, calls[2]?.options?.sessionId);
});

test("fails closed after two bad verdicts without a third attempt", async () => {
  const { calls, review } = stubReviewer(reply(malformed), reply(tierInvalid));
  assert.deepEqual(await review(input), { ok: false, error: "reviewer returned an invalid tier for the decision" });
  assert.equal(calls.length, 2);
});

test("retries with fresh evidence when the corrective exchange would exceed the context budget", async () => {
  const bad = reply(malformed.repeat(500));
  const good = reply(JSON.stringify(approval));
  const { calls, state, review } = stubReviewer(bad, good);
  const command = `first request ${"x".repeat(395_000)}`;
  assert.deepEqual(await review({ ...input, command }), { ok: true, verdict: approval });
  assert.equal(calls.length, 2);
  const [first, retry] = calls;
  const budget = contextBudget(128_000);
  assert.ok(estimateTokens(first!.systemPrompt, [...first!.messages, bad]) >= budget);
  assert.ok(estimateTokens(retry!.systemPrompt, retry!.messages) < budget);
  assert.notEqual(retry!.options?.sessionId, first!.options?.sessionId);
  assert.equal(retry!.options?.signal, first!.options?.signal);
  assert.equal(retry!.messages.length, 1);
  const [retryUser] = retry!.messages;
  assert.equal(retryUser?.role, "user");
  assert.match(JSON.stringify(retryUser.content), /<EVIDENCE>.*first request.*reviewer returned no JSON object/);
  assert.doesNotMatch(JSON.stringify(retryUser.content), /not a JSON verdict/);
  assert.deepEqual(state.lineage?.messages, [...first!.messages, good]);
  assert.notEqual(state.lineage?.sessionId, retry!.options?.sessionId);
});

test("headless reviewer-backed gate blocks after a tier-invalid verdict and a malformed retry", async () => {
  const { calls, review } = stubReviewer(reply(tierInvalid), reply(malformed));
  let dialogs = 0;
  const result = await handleToolCall(
    { toolName: "bash", input: { command: "danger now" } },
    {
      cwd: "/repo",
      signal: undefined,
      hasUI: false,
      isProjectTrusted: () => true,
      ui: {
        confirm: async () => {
          dialogs++;
          return true;
        },
        notify: () => {},
      },
    },
    () => parseConfig({ enabled: true, reviewMode: "auto" }, "test"),
    { review },
  );
  assert.deepEqual(result, { block: true, reason: "Automatic review failed: reviewer returned no JSON object" });
  assert.equal(calls.length, 2);
  assert.equal(dialogs, 0);
});

for (const interruption of ["parent abort", "original timeout"] as const) {
  test(`fails closed on ${interruption} during the corrective request and ignores late approval`, {
    timeout: 1000,
  }, async (t) => {
    const keepAlive = setInterval(() => {}, 1000);
    t.after(() => clearInterval(keepAlive));
    const controller = new AbortController();
    let startRetry!: () => void;
    const started = new Promise<void>((resolve) => {
      startRetry = resolve;
    });
    let finishRetry!: (message: AssistantMessage) => void;
    const deferred = new Promise<AssistantMessage>((resolve) => {
      finishRetry = resolve;
    });
    const { calls, state, review } = stubReviewer(reply(malformed), () => {
      startRetry();
      return deferred;
    });
    const pending = review({
      ...input,
      signal: controller.signal,
      reviewer: { ...DEFAULT_REVIEWER, timeoutMs: 100 },
    });
    await started;
    assert.equal(calls.length, 2);
    const retrySignal = calls[1]?.options?.signal;
    assert.ok(retrySignal);
    assert.equal(retrySignal, calls[0]?.options?.signal, "retry must use the original deadline");
    assert.equal(retrySignal.aborted, false);
    if (interruption === "parent abort") controller.abort();
    const expected = {
      ok: false,
      error: "review timed out or was cancelled",
      ...(interruption === "parent abort" ? { cancelled: true } : {}),
    };
    assert.deepEqual(await pending, expected);
    assert.equal(retrySignal.aborted, true);
    finishRetry(reply(JSON.stringify(approval)));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(await pending, expected);
    assert.equal(state.lineage, undefined);
    assert.equal(calls.length, 2);
  });
}

test("fails closed without retrying provider errors", async () => {
  for (const error of [
    reply(malformed, "error", "provider unavailable"),
    async () => {
      throw new Error("provider unavailable");
    },
  ]) {
    const { calls, review } = stubReviewer(error);
    assert.deepEqual(await review(input), { ok: false, error: "provider unavailable" });
    assert.equal(calls.length, 1);
  }
});

test("fails closed without retrying a timed-out provider", async (t) => {
  // AbortSignal.timeout does not keep the test process alive.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const { calls, review } = stubReviewer(() => new Promise(() => {}));
  assert.deepEqual(await review({ ...input, reviewer: { ...DEFAULT_REVIEWER, timeoutMs: 10 } }), {
    ok: false,
    error: "review timed out or was cancelled",
  });
  assert.equal(calls.length, 1);
});

test("fails closed without retrying an aborted review", async () => {
  const controller = new AbortController();
  const { calls, review } = stubReviewer(async () => {
    controller.abort();
    return reply(malformed);
  });
  assert.deepEqual(await review({ ...input, signal: controller.signal }), {
    ok: false,
    error: "review timed out or was cancelled",
    cancelled: true,
  });
  assert.equal(calls.length, 1);
});
