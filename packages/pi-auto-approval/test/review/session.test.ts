import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, Context, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { DEFAULT_REVIEW_EVIDENCE, DEFAULT_REVIEWER } from "../../src/config.ts";
import { BUDGET_EXCEEDED_ERROR } from "../../src/review/protocol.ts";
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
  const calls: { messages: Context["messages"]; options?: ModelsSimpleStreamOptions }[] = [];
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
      streamSimple: (_model, { messages }, options) => {
        calls.push({ messages: structuredClone(messages), options });
        const next = replies.shift();
        assert.ok(next, "unexpected provider call");
        return { result: async () => (typeof next === "function" ? next() : next) };
      },
    },
  };
  return { calls, review: createPiReviewer(ctx, createReviewerState()) };
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

test("fails closed when the corrective turn would exceed the review context budget", async () => {
  const { calls, review } = stubReviewer(reply(malformed.repeat(25_000)));
  assert.deepEqual(await review(input), { ok: false, error: BUDGET_EXCEEDED_ERROR });
  assert.equal(calls.length, 1);
});

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
