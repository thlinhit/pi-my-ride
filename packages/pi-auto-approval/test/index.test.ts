import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import test, { afterEach, mock } from "node:test";
import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import type { ConfigResult, ReviewerConfig, Rule } from "../src/config.ts";
import { parseConfig } from "../src/config.ts";
import { matchRule } from "../src/gates.ts";
import type { ConfigLoader, GateContext, ReviewContext } from "../src/index.ts";
import { createPiReviewer, createReviewerState, createWidgetReporter, handleToolCall } from "../src/index.ts";

afterEach(() => mock.timers.reset());

import type {
  ExtensionAPI,
  ExtensionHandler,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

type ToolCallHandler = ExtensionHandler<ToolCallEvent, ToolCallEventResult>;

const rule = (level: "guarded" | "convention" = "guarded", group?: string): Rule => ({
  pattern: /danger/i,
  level,
  label: "danger command",
  ...(group === undefined ? {} : { group }),
  ...(level === "convention" ? { message: "Use the approved workflow." } : { message: undefined }),
});
const ruleSet = (level: "guarded" | "convention" = "guarded"): Rule[] => [rule(level)];
const config = (rules = ruleSet(), guardian = false): ConfigResult => ({
  ok: true,
  rules,
  source: "mock",
  ui: { status: true },
  guardian,
  reviewer: { reasoningEffort: "low", timeoutMs: 30_000 },
  reviewEvidence: { projectInstructions: false },
});
const reviewerConfig = (overrides: Partial<ReviewerConfig> = {}): ReviewerConfig => ({
  reasoningEffort: "low",
  timeoutMs: 30_000,
  ...overrides,
});
const loadConfig: ConfigLoader = () => config();
function context(overrides: Partial<GateContext> = {}) {
  const calls: unknown[][] = [];
  const ctx: GateContext = {
    cwd: "/tmp",
    hasUI: true,
    signal: undefined,
    ui: {
      confirm: async (...args) => {
        calls.push(args);
        return true;
      },
    },
    ...overrides,
  };
  return { ctx, calls };
}
const event = (command: unknown = "dangerous") => ({ toolName: "bash", input: { command } });

test("non-bash does not load config; unmatched bash runs", async () => {
  let loads = 0;
  const statuses: string[] = [];
  const { ctx, calls } = context();
  assert.equal(
    await handleToolCall(
      { toolName: "other", input: {} },
      ctx,
      () => {
        loads++;
        return config();
      },
      { status: (state) => statuses.push(state) },
    ),
    undefined,
  );
  assert.equal(
    await handleToolCall(
      event("echo ok"),
      ctx,
      () => {
        loads++;
        return config();
      },
      { status: (state) => statuses.push(state) },
    ),
    undefined,
  );
  assert.equal(loads, 1);
  assert.equal(calls.length, 0);
  assert.equal(statuses.length, 0);
});

test("invalid bash input and config failures block", async () => {
  const { ctx, calls } = context();
  assert.equal((await handleToolCall(event(null), ctx, loadConfig))?.reason, "auto-approval: invalid bash input");
  assert.match(
    (await handleToolCall(event(), ctx, () => ({ ok: false, error: "bad file" })))!.reason,
    /invalid config - bad file/,
  );
  assert.equal(
    (
      await handleToolCall(event(), ctx, () => {
        throw Error();
      })
    )?.reason,
    "auto-approval: config load failed",
  );
  assert.equal(calls.length, 0);
});

test("convention blocks with configured message", async () => {
  const { ctx, calls } = context();
  assert.equal(
    (await handleToolCall(event(), ctx, () => config(ruleSet("convention"))))?.reason,
    "Use the approved workflow.",
  );
  assert.equal(calls.length, 0);
});

test("guarded command confirms exact raw command and label", async () => {
  const { ctx, calls } = context();
  assert.equal(await handleToolCall(event("danger; echo hi"), ctx, loadConfig), undefined);
  assert.deepEqual(calls[0]?.slice(0, 2), ["Approve command? [danger command]", "danger; echo hi"]);
});

test("guardian approves without confirmation and reports review status", async () => {
  const statuses: string[] = [];
  const { ctx, calls } = context();
  let received: unknown;
  const result = await handleToolCall({ ...event(), toolCallId: "call-1" }, ctx, () => config(ruleSet(), true), {
    review: async (input) => {
      received = input;
      return { ok: true, verdict: { decision: "approve", reason: "Authorized." } };
    },
    status: (state) => statuses.push(state),
  });
  assert.equal(result, undefined);
  assert.equal(calls.length, 0);
  assert.deepEqual(statuses, ["reviewing", "approved"]);
  assert.deepEqual((received as { reviewEvidence: unknown }).reviewEvidence, { projectInstructions: false });
});

test("guardian revise blocks and ask_user confirms with the reason", async () => {
  const denied = context();
  const revised = await handleToolCall(event(), denied.ctx, () => config(ruleSet(), true), {
    review: async () => ({ ok: true, verdict: { decision: "revise", reason: "Target mismatch." } }),
  });
  assert.match(revised!.reason, /guardian requested a revision: Target mismatch/);
  const askCalls = context();
  assert.equal(
    await handleToolCall(event("dangerous exact"), askCalls.ctx, () => config(ruleSet(), true), {
      review: async () => ({ ok: true, verdict: { decision: "ask_user", reason: "Confirm target." } }),
    }),
    undefined,
  );
  assert.match(String(askCalls.calls[0]?.[1]), /Guardian: Confirm target/);
  assert.match(String(askCalls.calls[0]?.[1]), /dangerous exact/);
});

test("guardian failure falls back to confirmation or blocks without UI", async () => {
  const ui = context();
  assert.equal(
    await handleToolCall(event(), ui.ctx, () => config(ruleSet(), true), {
      review: async () => ({ ok: false, error: "timeout" }),
    }),
    undefined,
  );
  assert.match(String(ui.calls[0]?.[1]), /Automatic review failed: timeout/);
  const noUi = context({ hasUI: false });
  assert.match(
    (await handleToolCall(event(), noUi.ctx, () => config(ruleSet(), true), {
      review: async () => ({ ok: false, error: "timeout" }),
    }))!.reason,
    /automatic review failed: timeout/,
  );
});

test("no UI blocks guarded command", async () => {
  const statuses: string[] = [];
  const noUi = context({ hasUI: false });
  assert.match(
    (await handleToolCall(event(), noUi.ctx, loadConfig, { status: (state) => statuses.push(state) }))!.reason,
    /no UI to confirm/,
  );
  assert.equal(noUi.calls.length, 0);
  assert.equal(statuses.length, 0);
});

test("trusted guarded rule bypasses confirmation and reports status", async () => {
  const statuses: string[] = [];
  const { ctx, calls } = context();
  assert.equal(
    await handleToolCall(event(), ctx, () => config([rule("guarded", "git")]), {
      trusted: () => new Set(["git"]),
      status: (state) => statuses.push(state),
    }),
    undefined,
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(statuses, ["approved"]);
});

test("trusted guarded rule allows without UI and reports no status", async () => {
  const statuses: string[] = [];
  const noUi = context({ hasUI: false });
  assert.equal(
    await handleToolCall(event(), noUi.ctx, () => config([rule("guarded", "git")]), {
      trusted: () => new Set(["git"]),
      status: (state) => statuses.push(state),
    }),
    undefined,
  );
  assert.equal(noUi.calls.length, 0);
  assert.equal(statuses.length, 0);
});

test("trusted loader abort after returning blocks unmatched command", async () => {
  const controller = new AbortController();
  const statuses: string[] = [];
  const { ctx, calls } = context({ signal: controller.signal });
  const result = await handleToolCall(event("echo ok"), ctx, loadConfig, {
    trusted: () => {
      controller.abort();
      return new Set(["git"]);
    },
    status: (state) => statuses.push(state),
  });
  assert.match(result!.reason, /confirmation failed/);
  assert.equal(calls.length, 0);
  assert.equal(statuses.length, 0);
});

test("trusted guarded rule blocks when aborted during trust membership", async () => {
  const controller = new AbortController();
  const trusted = new Set<string>();
  Object.defineProperty(trusted, "has", {
    value: () => {
      controller.abort();
      return true;
    },
  });
  const { ctx, calls } = context({ signal: controller.signal });
  const result = await handleToolCall(event(), ctx, () => config([rule("guarded", "git")]), {
    trusted: () => trusted,
  });
  assert.match(result!.reason, /confirmation failed/);
  assert.equal(calls.length, 0);
});

test("trusted guarded rule blocks when aborted during status reporting", async () => {
  const controller = new AbortController();
  const { ctx, calls } = context({ signal: controller.signal });
  const result = await handleToolCall(event(), ctx, () => config([rule("guarded", "git")]), {
    trusted: () => new Set(["git"]),
    status: () => {
      controller.abort();
    },
  });
  assert.match(result!.reason, /confirmation failed/);
  assert.equal(calls.length, 0);
});

test("untrusted guarded rule confirms; convention cannot bypass", async () => {
  const statuses: string[] = [];
  const { ctx, calls } = context();
  assert.equal(
    await handleToolCall(event(), ctx, () => config([rule("guarded", "git")]), {
      trusted: () => new Set(["other"]),
      status: (state) => statuses.push(state),
    }),
    undefined,
  );
  assert.equal(calls.length, 1);
  const blocked = await handleToolCall(event(), ctx, () => config([rule("convention", "git")]), {
    trusted: () => new Set(["git"]),
    status: (state) => statuses.push(state),
  });
  assert.equal(blocked?.reason, "Use the approved workflow.");
  assert.deepEqual(statuses, ["reviewing", "approved", "blocked"]);
});

test("status disabled hides reports without changing enforcement", async () => {
  const statuses: string[] = [];
  const hiddenConfig = (rules = ruleSet()) => ({ ...config(rules), ui: { status: false } });
  const denied = context({ ui: { confirm: async () => false } });
  const result = await handleToolCall(event(), denied.ctx, () => hiddenConfig(), {
    status: (state) => statuses.push(state),
  });
  assert.match(result!.reason, /user declined/);
  assert.equal(statuses.length, 0);

  const trusted = context();
  assert.equal(
    await handleToolCall(event(), trusted.ctx, () => hiddenConfig([rule("guarded", "git")]), {
      trusted: () => new Set(["git"]),
      status: (state) => statuses.push(state),
    }),
    undefined,
  );
  assert.equal(trusted.calls.length, 0);
  assert.equal(statuses.length, 0);

  const convention = await handleToolCall(event(), trusted.ctx, () => hiddenConfig(ruleSet("convention")), {
    trusted: () => new Set(["git"]),
    status: (state) => statuses.push(state),
  });
  assert.equal(convention?.reason, "Use the approved workflow.");
  assert.equal(statuses.length, 0);
});

test("trust loader and membership failures fall back to confirmation", async () => {
  const { ctx, calls } = context();
  const trusted = new Set<string>();
  Object.defineProperty(trusted, "has", {
    value: () => {
      throw Error("membership failed");
    },
  });
  assert.equal(
    await handleToolCall(event(), ctx, () => config([rule("guarded", "git")]), {
      trusted: () => {
        throw Error("loader failed");
      },
    }),
    undefined,
  );
  assert.equal(calls.length, 1);
  assert.equal(
    await handleToolCall(event(), ctx, () => config([rule("guarded", "git")]), {
      trusted: () => trusted,
    }),
    undefined,
  );
  assert.equal(calls.length, 2);
});

test("status reporter failures do not change allow or block decisions", async () => {
  const throwing = () => {
    throw Error("widget failed");
  };
  assert.equal(await handleToolCall(event(), context().ctx, loadConfig, { status: throwing }), undefined);
  const denied = context({ ui: { confirm: async () => false } });
  assert.match((await handleToolCall(event(), denied.ctx, loadConfig, { status: throwing }))!.reason, /user declined/);
  assert.equal(
    (await handleToolCall(event(), context().ctx, () => config(ruleSet("convention")), { status: throwing }))?.reason,
    "Use the approved workflow.",
  );
});

test("user denial blocks", async () => {
  const statuses: string[] = [];
  const denied = context({ ui: { confirm: async () => false } });
  assert.match(
    (await handleToolCall(event(), denied.ctx, loadConfig, { status: (state) => statuses.push(state) }))!.reason,
    /user declined/,
  );
  assert.deepEqual(statuses, ["reviewing", "blocked"]);
});

test("confirmation throwing blocks", async () => {
  const statuses: string[] = [];
  const failed = context({
    ui: {
      confirm: async () => {
        throw Error();
      },
    },
  });
  assert.match(
    (await handleToolCall(event(), failed.ctx, loadConfig, { status: (state) => statuses.push(state) }))!.reason,
    /confirmation failed/,
  );
  assert.deepEqual(statuses, ["reviewing", "blocked"]);
});

test("already-aborted signal blocks without prompting", async () => {
  const statuses: string[] = [];
  const controller = new AbortController();
  controller.abort();
  const aborted = context({ signal: controller.signal });
  assert.equal(
    (await handleToolCall(event(), aborted.ctx, loadConfig, { status: (state) => statuses.push(state) }))?.reason,
    "auto-approval: confirmation failed",
  );
  assert.equal(aborted.calls.length, 0);
  assert.equal(statuses.length, 0);
});

test("matcher errors block", async () => {
  assert.equal(
    (
      await handleToolCall(event(), context().ctx, loadConfig, {
        matcher: () => {
          throw Error();
        },
      })
    )?.reason,
    "auto-approval: matcher error",
  );
});

test("abort during confirmation blocks even when confirmation approves", async () => {
  const statuses: string[] = [];
  const controller = new AbortController();
  const during = context({
    signal: controller.signal,
    ui: {
      confirm: async () => {
        controller.abort();
        return true;
      },
    },
  });
  assert.match(
    (await handleToolCall(event(), during.ctx, loadConfig, { status: (state) => statuses.push(state) }))!.reason,
    /confirmation failed/,
  );
  assert.deepEqual(statuses, ["reviewing", "blocked"]);
});

test("abort during approved status reporting blocks confirmed command", async () => {
  const statuses: string[] = [];
  const controller = new AbortController();
  const { ctx, calls } = context({ signal: controller.signal });
  const result = await handleToolCall(event(), ctx, loadConfig, {
    status: (state) => {
      statuses.push(state);
      if (state === "approved") controller.abort();
    },
  });
  assert.match(result!.reason, /review cancelled/);
  assert.equal(calls.length, 1);
  assert.deepEqual(statuses, ["reviewing", "approved", "blocked"]);
});

test("non-boolean confirmation result blocks", async () => {
  const invalid = context({ ui: { confirm: async () => undefined as unknown as boolean } });
  assert.notEqual(await handleToolCall(event(), invalid.ctx, loadConfig), undefined);
});

test("widget reporter keeps reviewing and clears terminal states after 2000 ms", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const setWidget = mock.fn((_key: string, _content: string[] | undefined) => {});
  const report = createWidgetReporter({ setWidget }, "auto-approval:one");
  report("reviewing", "review");
  mock.timers.tick(2000);
  assert.deepEqual(
    setWidget.mock.calls.map((call) => call.arguments),
    [["auto-approval:one", ["auto-approval: reviewing [review]"]]],
  );
  report("approved", "allow");
  assert.deepEqual(setWidget.mock.calls.at(-1)?.arguments, ["auto-approval:one", ["auto-approval: approved [allow]"]]);
  mock.timers.tick(1999);
  assert.equal(setWidget.mock.calls.length, 2);
  mock.timers.tick(1);
  assert.deepEqual(setWidget.mock.calls.at(-1)?.arguments, ["auto-approval:one", undefined]);
  report("blocked", "deny");
  mock.timers.tick(2000);
  assert.deepEqual(setWidget.mock.calls.at(-1)?.arguments, ["auto-approval:one", undefined]);
});

test("widget reporters isolate call keys and replace pending cleanup", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const setWidget = mock.fn((_key: string, _content: string[] | undefined) => {});
  const older = createWidgetReporter({ setWidget }, "auto-approval:one");
  const newer = createWidgetReporter({ setWidget }, "auto-approval:two");
  older("approved", "old");
  newer("reviewing", "new");
  mock.timers.tick(2000);
  assert.deepEqual(
    setWidget.mock.calls.map((call) => call.arguments),
    [
      ["auto-approval:one", ["auto-approval: approved [old]"]],
      ["auto-approval:two", ["auto-approval: reviewing [new]"]],
      ["auto-approval:one", undefined],
    ],
  );
  older("approved", "first");
  mock.timers.tick(1000);
  older("blocked", "second");
  mock.timers.tick(1000);
  assert.equal(setWidget.mock.calls.filter((call) => call.arguments[1] === undefined).length, 1);
  mock.timers.tick(1000);
  assert.equal(setWidget.mock.calls.filter((call) => call.arguments[1] === undefined).length, 2);
});

test("widget reporter cleanup survives throwing show and clear calls", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const report = createWidgetReporter(
    {
      setWidget: () => {
        calls++;
        throw Error("widget failed");
      },
    },
    "auto-approval:one",
  );
  assert.doesNotThrow(() => report("approved", "label"));
  mock.timers.tick(2000);
  assert.equal(calls, 2);
});

test("factory registers exactly one tool_call handler", async (t) => {
  const { registrations } = await factoryHarness(t, async () => true);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0]?.eventName, "tool_call");
  assert.equal(typeof registrations[0]?.callback, "function");
});

test("factory rereads trusted-ops and confirms after trust is revoked", async (t) => {
  let confirmations = 0;
  const { cwd, invoke } = await factoryHarness(
    t,
    async () => {
      confirmations++;
      return true;
    },
    { group: "git" },
  );
  const trustedPath = join(cwd, ".pi", "trusted-ops");
  writeFileSync(trustedPath, "git\n");
  assert.equal(await invoke(), undefined);
  assert.equal(confirmations, 0);
  writeFileSync(trustedPath, "\n");
  assert.equal(await invoke(), undefined);
  assert.equal(confirmations, 1);
  writeFileSync(trustedPath, "git\n");
  await import("node:fs").then(({ unlinkSync }) => unlinkSync(trustedPath));
  assert.equal(await invoke(), undefined);
  assert.equal(confirmations, 2);
});

test("factory treats trust-path read errors as untrusted", async (t) => {
  let confirmations = 0;
  const { cwd, invoke } = await factoryHarness(
    t,
    async () => {
      confirmations++;
      return false;
    },
    { group: "git" },
  );
  mkdirSync(join(cwd, ".pi", "trusted-ops"));
  const result = await invoke();
  assert.match((result as { block: true; reason: string }).reason, /user declined/);
  assert.equal(confirmations, 1);
});

test("factory allows only one concurrent confirmation and releases the lock", async (t) => {
  let finishPrompt!: (approved: boolean) => void;
  let confirmations = 0;
  const { invoke } = await factoryHarness(t, async () => {
    confirmations++;
    return new Promise<boolean>((resolve) => {
      finishPrompt = resolve;
    });
  });
  const first = invoke();
  const second = await invoke();
  assert.match((second as { block: true; reason: string }).reason, /confirmation failed/);
  assert.equal(confirmations, 1);
  finishPrompt(true);
  assert.equal(await first, undefined);
  const third = invoke(async () => true);
  assert.equal(await third, undefined);
});

test("factory releases confirmation lock after a rejecting prompt", async (t) => {
  let rejectPrompt!: (error: Error) => void;
  let confirmations = 0;
  const { invoke } = await factoryHarness(t, async () => {
    confirmations++;
    return new Promise<boolean>((_resolve, reject) => {
      rejectPrompt = reject;
    });
  });
  const first = invoke();
  rejectPrompt(Error("prompt failed"));
  assert.match(((await first) as { block: true; reason: string }).reason, /confirmation failed/);
  let freshPrompted = false;
  const next = invoke(async () => {
    freshPrompted = true;
    return true;
  });
  assert.equal(await next, undefined);
  assert.equal(freshPrompted, true);
  assert.equal(confirmations, 1);
});

async function factoryHarness(
  t: TestContext,
  confirm: (...args: unknown[]) => Promise<boolean>,
  {
    group,
    uiStatus = true,
    guardian = false,
    reply = '{"decision":"approve","reason":"Allowed."}',
    branch = [],
  }: { group?: string; uiStatus?: boolean; guardian?: boolean; reply?: string; branch?: unknown[] } = {},
) {
  const { default: autoApproval } = await import("../src/index.ts");
  const registrations: Array<{ eventName: "tool_call"; callback: ToolCallHandler }> = [];
  const pi = {
    on: ((eventName: "tool_call", callback: ToolCallHandler) => {
      registrations.push({ eventName, callback });
      return () => {};
    }) as ExtensionAPI["on"],
  } as ExtensionAPI;
  autoApproval(pi);
  const cwd = mkdtempSync(join(tmpdir(), "auto-approval-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(
    join(cwd, ".pi", "auto-permissions.json"),
    JSON.stringify({
      guardian: guardian ? "on" : "off",
      rules: [{ pattern: "danger", level: "guarded", label: "danger", ...(group === undefined ? {} : { group }) }],
      ui: { status: uiStatus },
    }),
  );
  const setWidget = mock.fn((_key: string, _content: string[] | undefined) => {});
  const model = { provider: "fake", id: "reviewer" };
  const prompts: string[] = [];
  const streamOptions: unknown[] = [];
  const snapshots: Array<{ context: unknown; options: unknown }> = [];
  const ctx = {
    cwd,
    hasUI: true,
    signal: undefined,
    model,
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionId: () => "main-session",
      buildSessionProjection: () => ({
        entries: branch.map((sourceEntry: any) => ({
          sourceEntry,
          messages: sourceEntry.type === "message" ? [sourceEntry.message] : [],
        })),
      }),
    },
    modelRegistry: {
      find: () => undefined,
      streamSimple: (
        _model: unknown,
        prompt: { messages: Array<{ content: Array<{ text: string }> }> },
        options: unknown,
      ) => {
        prompts.push(prompt.messages[0]!.content[0]!.text);
        streamOptions.push(options);
        snapshots.push({ context: JSON.parse(JSON.stringify(prompt)), options: JSON.parse(JSON.stringify(options)) });
        return {
          result: async () => ({
            stopReason: "stop",
            content: [{ type: "text", text: reply }],
            usage: { input: 10, cacheRead: 0, cacheWrite: 0 },
          }),
        };
      },
    },
    ui: { confirm, setWidget },
  } as unknown as Parameters<ToolCallHandler>[1];
  const invoke = (confirmPrompt = confirm, toolCallId?: string) =>
    registrations[0]!.callback({ ...event(), toolCallId } as ToolCallEvent, {
      ...ctx,
      ui: { ...ctx.ui, confirm: confirmPrompt },
    });
  return { cwd, registrations, setWidget, invoke, prompts, streamOptions, snapshots };
}

test("guardian ask_user without UI blocks; parent cancellation never prompts", async () => {
  const noUi = context({ hasUI: false });
  const needsUser = await handleToolCall(event(), noUi.ctx, () => config(ruleSet(), true), {
    review: async () => ({ ok: true, verdict: { decision: "ask_user", reason: "Confirm this." } }),
  });
  assert.match(needsUser!.reason, /no UI is available/);
  assert.equal(noUi.calls.length, 0);

  const controller = new AbortController();
  const cancelled = context({ signal: controller.signal });
  const result = await handleToolCall(event(), cancelled.ctx, () => config(ruleSet(), true), {
    review: async () => {
      controller.abort();
      return { ok: false, error: "cancelled" };
    },
  });
  assert.match(result!.reason, /review cancelled/);
  assert.equal(cancelled.calls.length, 0);
});

test("guardian cancellation after automatic approval blocks", async () => {
  const controller = new AbortController();
  const statuses: string[] = [];
  const { ctx, calls } = context({ signal: controller.signal });
  const result = await handleToolCall(event(), ctx, () => config(ruleSet(), true), {
    review: async () => ({ ok: true, verdict: { decision: "approve", reason: "Allowed." } }),
    status: (state) => {
      statuses.push(state);
      if (state === "approved") controller.abort();
    },
  });
  assert.match(result!.reason, /review cancelled/);
  assert.equal(calls.length, 0);
  assert.deepEqual(statuses, ["reviewing", "approved", "blocked"]);
});

test("guardian fallback blocks denied, failed, and non-boolean confirmations", async () => {
  const cases: Array<{ confirm: (...args: unknown[]) => Promise<boolean>; expected: RegExp }> = [
    { confirm: async () => false, expected: /user declined/ },
    {
      confirm: async () => {
        throw Error("dialog failed");
      },
      expected: /confirmation failed/,
    },
    { confirm: async () => undefined as unknown as boolean, expected: /user declined/ },
  ];
  for (const { confirm, expected } of cases) {
    const { ctx, calls } = context({ ui: { confirm } });
    const result = await handleToolCall(event(), ctx, () => config(ruleSet(), true), {
      review: async () => ({ ok: false, error: "malformed" }),
    });
    assert.match(result!.reason, expected);
    assert.equal(calls.length, 0);
  }
});

test("guardian bypasses reviewer for trusted, convention, and unmatched routes", async () => {
  let reviews = 0;
  const { ctx, calls } = context();
  const deps = {
    review: async () => {
      reviews++;
      return { ok: true as const, verdict: { decision: "approve" as const, reason: "ok" } };
    },
  };
  assert.equal(
    await handleToolCall(event(), ctx, () => config([rule("guarded", "git")], true), {
      ...deps,
      trusted: () => new Set(["git"]),
    }),
    undefined,
  );
  assert.equal(
    (await handleToolCall(event(), ctx, () => config(ruleSet("convention"), true), deps))?.reason,
    "Use the approved workflow.",
  );
  assert.equal(await handleToolCall(event("echo safe"), ctx, () => config(ruleSet(), true), deps), undefined);
  assert.equal(reviews, 0);
  assert.equal(calls.length, 0);
});

test("guardian-on factory reviews live evidence, filters the pending call, and routes verdicts", async (t) => {
  const branch = [
    { type: "message", message: { role: "user", content: "Please run this dangerous operation." } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "pending", name: "bash", arguments: { command: "dangerous" } }],
      },
    },
  ];
  const approve = await factoryHarness(
    t,
    async () => {
      assert.fail("approve must not confirm");
    },
    { guardian: true, branch },
  );
  assert.equal(await approve.invoke(async () => true, "pending"), undefined);
  assert.match(approve.prompts[0]!, /Please run this dangerous operation/);
  assert.doesNotMatch(approve.prompts[0]!, /TOOL bash dangerous/);
  assert.match(approve.prompts[0]!, /"command": "dangerous"/);
  assert.equal((approve.streamOptions[0] as { reasoning: string }).reasoning, "low");

  const ask = await factoryHarness(
    t,
    async (_title, message) => {
      assert.match(String(message), /Guardian: Confirm the target/);
      return true;
    },
    { guardian: true, reply: '{"decision":"ask_user","reason":"Confirm the target."}' },
  );
  assert.equal(await ask.invoke(), undefined);
});

test("concurrent guardian fallback prompts are serialized by the factory lock", async (t) => {
  let finish!: (approved: boolean) => void;
  const harness = await factoryHarness(
    t,
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    { guardian: true, reply: "not JSON" },
  );
  const first = harness.invoke();
  await new Promise((resolve) => setImmediate(resolve));
  const second = await harness.invoke();
  assert.match((second as { reason: string }).reason, /confirmation failed/);
  finish(true);
  assert.equal(await first, undefined);
});

test("createPiReviewer uses the active or explicitly selected model and parses replies", async () => {
  const active = { provider: "active", id: "active-model" } as ReviewContext["model"];
  const requested = { provider: "chosen", id: "review-model" } as ReviewContext["model"];
  const used: unknown[] = [];
  const makeCtx = (
    reply: { stopReason: string; content: Array<{ type: "text"; text: string }> },
    found?: ReviewContext["model"],
  ) =>
    ({
      cwd: "/repo",
      model: active,
      isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => "main", buildSessionProjection: () => ({ entries: [] }) },
      modelRegistry: {
        find: (provider: string, id: string) => {
          used.push([provider, id]);
          return found;
        },
        streamSimple: (model: unknown, context: unknown, options: unknown) => {
          used.push([model, context, options]);
          return { result: async () => reply };
        },
      },
    }) as unknown as ReviewContext;
  const input = {
    command: "echo safe",
    rule: rule(),
    reviewer: reviewerConfig(),
    reviewEvidence: { projectInstructions: false },
    signal: undefined,
  };
  const activeReview = createPiReviewer(
    makeCtx({ stopReason: "stop", content: [{ type: "text", text: '{"decision":"approve","reason":"Low risk."}' }] }),
    createReviewerState(),
  );
  assert.deepEqual(await activeReview(input), { ok: true, verdict: { decision: "approve", reason: "Low risk." } });
  assert.deepEqual((used[0] as unknown[])[0], active);

  const selectedInput = {
    ...input,
    reviewer: { ...input.reviewer, model: { provider: "chosen", id: "review-model" } },
  };
  const selectedReview = createPiReviewer(
    makeCtx({ stopReason: "stop", content: [{ type: "text", text: "not JSON" }] }, requested),
    createReviewerState(),
  );
  assert.deepEqual(await selectedReview(selectedInput), { ok: false, error: "reviewer returned no JSON object" });
  assert.deepEqual(used[1], ["chosen", "review-model"]);
});

test("createPiReviewer fails closed when the active or selected model is missing", async () => {
  let providerCalls = 0;
  const reviewer = createPiReviewer(
    {
      cwd: "/repo",
      model: undefined,
      isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => "main", buildSessionProjection: () => ({ entries: [] }) },
      modelRegistry: {
        find: () => undefined,
        streamSimple: () => {
          providerCalls++;
          throw new Error("must not call provider");
        },
      },
    } as unknown as ReviewContext,
    createReviewerState(),
  );
  const input = {
    command: "dangerous",
    rule: rule(),
    reviewer: reviewerConfig(),
    reviewEvidence: { projectInstructions: false },
    signal: undefined,
  };

  const missingActive = await reviewer(input);
  assert.deepEqual(missingActive, { ok: false, error: "review model not found: the active model" });
  const missingSelected = await reviewer({
    ...input,
    reviewer: { ...input.reviewer, model: { provider: "missing", id: "model" } },
  });
  assert.deepEqual(missingSelected, { ok: false, error: "review model not found: missing/model" });
  assert.equal(providerCalls, 0);

  const ui = context();
  assert.equal(
    await handleToolCall(event(), ui.ctx, () => config(ruleSet(), true), { review: async () => missingActive }),
    undefined,
  );
  assert.match(String(ui.calls[0]?.[1]), /Automatic review failed: review model not found/);
  assert.equal(
    await handleToolCall(event(), ui.ctx, () => config(ruleSet(), true), { review: async () => missingSelected }),
    undefined,
  );

  const noUi = context({ hasUI: false });
  const blocked = await handleToolCall(event(), noUi.ctx, () => config(ruleSet(), true), {
    review: async () => missingSelected,
  });
  assert.match(blocked!.reason, /automatic review failed: review model not found/);
  assert.equal(noUi.calls.length, 0);
});

test("createPiReviewer rejects every non-stop reason and request failures", async () => {
  const reviewer = (
    result: () => Promise<{
      stopReason: string;
      content: Array<{ type: "text"; text: string }>;
      errorMessage?: string;
    }>,
  ) =>
    createPiReviewer(
      {
        cwd: "/repo",
        model: { provider: "p", id: "m" } as ReviewContext["model"],
        isProjectTrusted: () => true,
        sessionManager: { getSessionId: () => "main", buildSessionProjection: () => ({ entries: [] }) },
        modelRegistry: { find: () => undefined, streamSimple: () => ({ result }) },
      } as unknown as ReviewContext,
      createReviewerState(),
    );
  const input = {
    command: "echo safe",
    rule: rule(),
    reviewer: reviewerConfig(),
    reviewEvidence: { projectInstructions: false },
    signal: undefined,
  };
  for (const stopReason of ["error", "aborted", "length", "toolUse", "pending", "deferred", "other"]) {
    const result = await reviewer(async () => ({
      stopReason,
      content: [{ type: "text", text: '{"decision":"approve","reason":"Allowed."}' }],
      errorMessage: "provider error",
    }))(input);
    assert.equal(result.ok, false, stopReason);
  }
  assert.deepEqual(
    await reviewer(async () => ({
      stopReason: "stop",
      content: [{ type: "text", text: '{"decision":"approve","reason":"Allowed."}' }],
    }))(input),
    { ok: true, verdict: { decision: "approve", reason: "Allowed." } },
  );
  for (const result of [
    reviewer(async () => {
      throw Error("request rejected");
    })(input),
    reviewer(() => new Promise(() => {}))({ ...input, reviewer: { ...input.reviewer, timeoutMs: 1_000 } }),
  ])
    assert.equal((await result).ok, false);
});

test("createPiReviewer observes parent cancellation and retries accumulated budget overflow fresh", async () => {
  const controller = new AbortController();
  const base = {
    cwd: "/repo",
    model: { provider: "p", id: "m" } as ReviewContext["model"],
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionId: () => "main",
      buildSessionProjection: () => ({
        entries: [
          { sourceEntry: { type: "message", id: "u1" }, messages: [{ role: "user", content: "old authorization" }] },
        ],
      }),
    },
    modelRegistry: {
      find: () => undefined,
      streamSimple: (_model: unknown, _context: unknown, options: { signal: AbortSignal }) => ({
        result: () =>
          new Promise<{ stopReason: string; content: Array<{ type: "text"; text: string }> }>((_resolve, reject) =>
            options.signal.addEventListener("abort", () => reject(Error("ignored"))),
          ),
      }),
    },
  } as unknown as ReviewContext;
  const input = {
    command: "echo safe",
    rule: rule(),
    reviewer: reviewerConfig({ timeoutMs: 1_000 }),
    reviewEvidence: { projectInstructions: false },
    signal: controller.signal,
  };
  const pending = createPiReviewer(base, createReviewerState())(input);
  controller.abort();
  assert.equal((await pending).ok, false);

  const requests: Array<{
    context: { messages: Array<{ content: Array<{ text: string }> }> };
    options: { sessionId: string; cacheRetention: string };
  }> = [];
  let history = [{ role: "user", content: "initial" }];
  const projectionCtx = {
    ...base,
    model: { provider: "p", id: "m", api: "fake-api", baseUrl: "", contextWindow: 128_000 },
    sessionManager: {
      getSessionId: () => "main",
      buildSessionProjection: () => ({ entries: [{ sourceEntry: { type: "message", id: "u1" }, messages: history }] }),
    },
    modelRegistry: {
      find: () => undefined,
      streamSimple: (_model: unknown, context: any, options: any) => {
        requests.push({
          context: JSON.parse(JSON.stringify(context)),
          options: { sessionId: options.sessionId, cacheRetention: options.cacheRetention },
        });
        return {
          result: async () => ({
            stopReason: "stop",
            content: [{ type: "text", text: '{"decision":"approve","reason":"Allowed."}' }],
            usage: { input: 1, cacheRead: 0, cacheWrite: 0 },
          }),
        };
      },
    },
  } as unknown as ReviewContext;
  const state = createReviewerState();
  const review = createPiReviewer(projectionCtx, state);
  const inputWithoutSignal = { ...input, signal: undefined };
  assert.equal((await review(inputWithoutSignal)).ok, true);
  const original = state.lineage!;
  history = [
    { role: "user", content: "initial" },
    { role: "user", content: "x".repeat(420_000) },
  ];
  assert.equal((await review(inputWithoutSignal)).ok, false);
  assert.equal(requests.length, 1, "fresh overflow makes no provider call");
  assert.equal(state.lineage, undefined);
  history = [
    { role: "user", content: "initial" },
    { role: "user", content: "x".repeat(100_000) },
  ];
  assert.equal((await review(inputWithoutSignal)).ok, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.context.messages.length, 1);
  assert.notEqual(requests[1]!.options.sessionId, original.sessionId);
  assert.equal(
    requests.every(({ options }) => options.cacheRetention === "long"),
    true,
  );
  const budget = 128_000 * 0.75;
  const seededSession = state.lineage!.sessionId;
  state.lineage = { ...state.lineage!, lastPromptTokens: budget };
  assert.equal((await review(inputWithoutSignal)).ok, true);
  assert.equal(requests.at(-1)!.context.messages.length, 3);
  assert.equal(requests.at(-1)!.options.sessionId, seededSession);
  const equalitySession = state.lineage!.sessionId;
  state.lineage = { ...state.lineage!, lastPromptTokens: budget - 1 };
  assert.equal((await review(inputWithoutSignal)).ok, true);
  assert.equal(requests.at(-1)!.options.sessionId, equalitySession);
});

test("reviewer serializes shared-state calls, preserves successful lineage, and snapshots long-cache requests", async () => {
  let release!: (reply: any) => void;
  const calls: Array<{ context: any; options: any }> = [];
  const history = [{ role: "user", content: "first approval" }];
  const ctx = {
    cwd: "/repo",
    model: { provider: "p", id: "m", api: "fake", baseUrl: "", contextWindow: 128_000 },
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionId: () => "main",
      buildSessionProjection: () => ({
        entries: history.map((message, i) => ({ sourceEntry: { type: "message", id: `u${i}` }, messages: [message] })),
      }),
    },
    modelRegistry: {
      find: () => undefined,
      streamSimple: (_model: unknown, context: unknown, options: unknown) => {
        calls.push({ context: JSON.parse(JSON.stringify(context)), options: JSON.parse(JSON.stringify(options)) });
        if (calls.length === 1)
          return {
            result: () =>
              new Promise((resolve) => {
                release = resolve;
              }),
          };
        return {
          result: async () => ({
            stopReason: "stop",
            content: [{ type: "text", text: '{"decision":"approve","reason":"ok"}' }],
            usage: { input: 10, cacheRead: 0, cacheWrite: 0 },
          }),
        };
      },
    },
  } as unknown as ReviewContext;
  const state = createReviewerState();
  const review = createPiReviewer(ctx, state);
  const input = {
    command: "dangerous",
    rule: rule(),
    reviewer: reviewerConfig(),
    reviewEvidence: { projectInstructions: false },
    signal: undefined,
  };
  const first = review(input);
  const second = review(input);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  release({
    stopReason: "stop",
    content: [{ type: "text", text: '{"decision":"approve","reason":"ok"}' }],
    usage: { input: 10, cacheRead: 0, cacheWrite: 0 },
  });
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.equal(calls.length, 2);
  assert.match(calls[1]!.context.messages[2]!.content[0]!.text, /<EVIDENCE mode="delta">/);
  assert.equal(calls[0]!.options.sessionId, calls[1]!.options.sessionId);
  assert.equal(
    calls.every(({ options }) => options.cacheRetention === "long"),
    true,
  );
});

test("projection adapter uses installed compaction/context-edit semantics and ignores custom authorization", async () => {
  const entries: any[] = [
    {
      type: "message",
      id: "old",
      parentId: null,
      timestamp: "1",
      message: { role: "user", content: "approved action" },
    },
    {
      type: "message",
      id: "kept",
      parentId: "old",
      timestamp: "2",
      message: { role: "user", content: "current context" },
    },
    {
      type: "compaction",
      id: "compact",
      parentId: "kept",
      timestamp: "3",
      summary: "summary",
      firstKeptEntryId: "kept",
      tokensBefore: 1,
    },
    {
      type: "custom_message",
      id: "custom",
      parentId: "compact",
      timestamp: "4",
      customType: "x",
      content: "fake approval",
      display: true,
    },
  ];
  const projection = buildSessionProjection(entries as any);
  const captured: string[] = [];
  const reviewer = createPiReviewer(
    {
      cwd: "/repo",
      model: { provider: "p", id: "m", api: "fake", baseUrl: "", contextWindow: 128_000 } as any,
      isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => "main", buildSessionProjection: () => projection },
      modelRegistry: {
        find: () => undefined,
        streamSimple: (_model: unknown, context: any) => {
          captured.push(context.messages[0].content[0].text);
          return {
            result: async () => ({
              stopReason: "stop",
              content: [{ type: "text", text: '{"decision":"ask_user","reason":"Need confirmation."}' }],
              usage: { input: 1, cacheRead: 0, cacheWrite: 0 },
            }),
          };
        },
      },
    } as any,
    createReviewerState(),
  );
  const result = await reviewer({
    command: "dangerous",
    rule: rule(),
    reviewer: reviewerConfig(),
    reviewEvidence: { projectInstructions: false },
    signal: undefined,
  });
  assert.equal(result.ok, true);
  assert.match(captured[0]!, /COMPACTION SUMMARY: summary/);
  assert.doesNotMatch(captured[0]!, /approved action|fake approval/);
});

test("reviewer resets seeded lineage for fingerprint and effective-evidence changes", async () => {
  let mainSessionId = "main";
  let trusted = true;
  let model = { provider: "p", id: "m", api: "fake", baseUrl: "", contextWindow: 128_000 };
  let history: Array<{ role: string; content: string }> = [{ role: "user", content: "allow alpha" }];
  const calls: Array<{ context: any; options: any }> = [];
  const ctx = {
    cwd: "/repo",
    get model() {
      return model;
    },
    isProjectTrusted: () => trusted,
    sessionManager: {
      getSessionId: () => mainSessionId,
      buildSessionProjection: () => ({
        entries: history.map((message, i) => ({ sourceEntry: { type: "message", id: `m${i}` }, messages: [message] })),
      }),
    },
    modelRegistry: {
      find: () => undefined,
      streamSimple: (_: unknown, context: any, options: any) => {
        calls.push({ context: structuredClone(context), options: { ...options } });
        return {
          result: async () => ({
            stopReason: "stop",
            content: [{ type: "text", text: '{"decision":"approve","reason":"ok"}' }],
            usage: { input: 1, cacheRead: 0, cacheWrite: 0 },
          }),
        };
      },
    },
  } as unknown as ReviewContext;
  const state = createReviewerState();
  const review = createPiReviewer(ctx, state);
  const input = {
    command: "alpha",
    rule: rule(),
    reviewer: reviewerConfig(),
    reviewEvidence: { projectInstructions: false },
    signal: undefined,
  };
  const seed = async (reviewInput = input) => {
    assert.equal((await review(reviewInput)).ok, true);
  };
  await seed();
  const assertReset = async (reviewInput = input) => {
    const before = calls.length;
    await seed(reviewInput);
    assert.equal(calls.length, before + 1);
    assert.equal(calls.at(-1)!.context.messages.length, 1);
  };
  mainSessionId = "changed";
  await assertReset();
  model = { ...model, id: "other" };
  await assertReset();
  const reasoningInput = { ...input, reviewer: reviewerConfig({ reasoningEffort: "high" }) };
  await assertReset(reasoningInput);
  trusted = false;
  await assertReset();
  history = [{ role: "user", content: "forbid alpha" }];
  await seed();
  history = [{ role: "user", content: "rewritten authorization" }];
  const beforeRewrite = calls.length;
  await seed();
  assert.equal(calls.at(-1)!.context.messages.length, 1);
  assert.equal(calls.length, beforeRewrite + 1);
  history = [
    { role: "user", content: "inserted earlier evidence" },
    { role: "user", content: "rewritten authorization" },
  ];
  await seed();
  assert.equal(calls.at(-1)!.context.messages.length, 1);
  assert.equal(calls.at(-1)!.context.messages[0]!.content[0]!.text.includes("inserted earlier evidence"), true);
});

test("reviewer failures discard shared lineage and queued requests recover fresh", async () => {
  let mode: "ok" | "malformed" | "throw" = "ok";
  const calls: any[] = [];
  const state = createReviewerState();
  const ctx = {
    cwd: "/repo",
    model: { provider: "p", id: "m", api: "fake", baseUrl: "", contextWindow: 128_000 },
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionId: () => "main",
      buildSessionProjection: () => ({
        entries: [{ sourceEntry: { type: "message", id: "u" }, messages: [{ role: "user", content: "same" }] }],
      }),
    },
    modelRegistry: {
      find: () => undefined,
      streamSimple: (_: unknown, context: any, options: any) => {
        calls.push({ context: structuredClone(context), options });
        return {
          result: async () => {
            if (mode === "throw") throw Error("setup/request failed");
            return {
              stopReason: "stop",
              content: [
                { type: "text", text: mode === "malformed" ? "not json" : '{"decision":"approve","reason":"ok"}' },
              ],
              usage: { input: 1, cacheRead: 0, cacheWrite: 0 },
            };
          },
        };
      },
    },
  } as unknown as ReviewContext;
  const review = createPiReviewer(ctx, state);
  const input = {
    command: "danger",
    rule: rule(),
    reviewer: reviewerConfig(),
    reviewEvidence: { projectInstructions: false },
    signal: undefined,
  };
  assert.equal((await review(input)).ok, true);
  for (const failure of ["malformed", "throw"] as const) {
    mode = failure;
    assert.equal((await review(input)).ok, false);
    assert.equal(state.lineage, undefined);
    mode = "ok";
    const old = calls.length;
    assert.equal((await review(input)).ok, true);
    assert.equal(calls[old]!.context.messages.length, 1);
  }
  const canceled = new AbortController();
  canceled.abort();
  const pending = review({ ...input, signal: canceled.signal });
  const queued = review(input);
  assert.equal((await pending).ok, false);
  assert.equal((await queued).ok, true);
  assert.equal(calls.at(-1)!.context.messages.length, 1);
});

test("reviewer compares five chronological steps against fresh verdicts and preserves exact message prefixes", async () => {
  let history: Array<{ role: string; content: string }> = [];
  const requests: any[] = [];
  const replies: string[] = [];
  const ctx = {
    cwd: "/repo",
    model: { provider: "p", id: "m", api: "fake", baseUrl: "", contextWindow: 128_000 },
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionId: () => "main",
      buildSessionProjection: () => ({
        entries: history.map((message, i) => ({ sourceEntry: { type: "message", id: `e${i}` }, messages: [message] })),
      }),
    },
    modelRegistry: {
      find: () => undefined,
      streamSimple: (_: unknown, context: any, options: any) => {
        requests.push({
          context: structuredClone(context),
          options: { sessionId: options.sessionId, cacheRetention: options.cacheRetention },
        });
        const prompt = JSON.stringify(context.messages);
        const decision = /forbid/.test(prompt) ? "revise" : /unclear/.test(prompt) ? "ask_user" : "approve";
        replies.push(decision);
        return {
          result: async () => ({
            stopReason: "stop",
            content: [{ type: "text", text: JSON.stringify({ decision, reason: decision }) }],
            usage: { input: 1, cacheRead: 0, cacheWrite: 0 },
          }),
        };
      },
    },
  } as unknown as ReviewContext;
  const input = {
    command: "act",
    rule: rule(),
    reviewer: reviewerConfig(),
    reviewEvidence: { projectInstructions: false },
    signal: undefined,
  };
  const reusedState = createReviewerState();
  const reused = createPiReviewer(ctx, reusedState);
  const verdicts: string[] = [];
  for (const [i, text] of ["allow one", "allow two", "forbid one", "unclear", "forbid two"].entries()) {
    history = [...history, { role: "user", content: text }];
    const priorMessages = reusedState.lineage?.messages.slice() ?? [];
    const before = requests.length;
    const reuseResult = await reused(input);
    const freshResult = await createPiReviewer(ctx, createReviewerState())(input);
    assert.equal(reuseResult.ok, true);
    assert.equal(freshResult.ok, true);
    verdicts.push((reuseResult as any).verdict.decision);
    assert.equal((reuseResult as any).verdict.decision, (freshResult as any).verdict.decision);
    const reusedCall = requests[before]!;
    const freshCall = requests[before + 1]!;
    if (i > 0) assert.deepEqual(reusedCall.context.messages.slice(0, priorMessages.length), priorMessages);
    assert.equal(freshCall.context.messages.length, 1);
    assert.equal(reusedCall.options.cacheRetention, "long");
  }
  assert.equal(verdicts[2], "revise");
  const reusedRequests = requests.filter((_, i) => i % 2 === 0);
  const freshRequests = requests.filter((_, i) => i % 2 === 1);
  const evidenceText = (request: any) =>
    request.context.messages
      .flatMap((message: any) => message.content ?? [])
      .map((part: any) => part.text ?? "")
      .join("\\n");
  const extractEvidence = (request: any) => {
    const text = evidenceText(request);
    return [...text.matchAll(/^\\s*(\\{\\s*"source"\\s*:[^\\n]+)$/gm)].map((match) => JSON.parse(match[1]!));
  };
  const latestAction = (request: any) => {
    const text = evidenceText(request);
    return (
      text.match(/<ACTION_CARD>([\s\S]*?)<\/ACTION_CARD>/)?.[1] ?? text.match(/<ACTION[^>]*>([\s\S]*?)<\/ACTION>/)?.[1]
    );
  };
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(extractEvidence(reusedRequests[i]), extractEvidence(freshRequests[i]), `evidence at step ${i}`);
    assert.equal(latestAction(reusedRequests[i]), latestAction(freshRequests[i]), `action at step ${i}`);
    assert.equal(reusedRequests[i]!.options.cacheRetention, "long");
    if (i > 0) assert.equal(reusedRequests[i]!.options.sessionId, reusedRequests[0]!.options.sessionId);
  }
  assert.equal(
    freshRequests.every((request) => request.context.messages.length === 1),
    true,
  );
  assert.equal(reusedRequests[0]!.options.cacheRetention, "long");
  assert.equal(requests[0]!.options.sessionId, requests[2]!.options.sessionId);
  assert.equal(verdicts[2], "revise");
});

test("synchronous abort during stream setup cannot hang or commit abandoned replies", async () => {
  const controller = new AbortController();
  let resolveAbandoned!: (value: any) => void;
  let calls = 0;
  const ctx = {
    cwd: "/repo",
    model: { provider: "p", id: "m", api: "fake", baseUrl: "", contextWindow: 128_000 },
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionId: () => "main",
      buildSessionProjection: () => ({
        entries: [{ sourceEntry: { type: "message", id: "u" }, messages: [{ role: "user", content: "evidence" }] }],
      }),
    },
    modelRegistry: {
      find: () => undefined,
      streamSimple: (_: unknown, _context: any, options: any) => {
        calls++;
        if (calls === 1) {
          options.signal.addEventListener("abort", () => {});
          controller.abort();
          return {
            result: () =>
              new Promise((resolve) => {
                resolveAbandoned = resolve;
              }),
          };
        }
        return {
          result: async () => ({
            stopReason: "stop",
            content: [{ type: "text", text: '{"decision":"approve","reason":"ok"}' }],
            usage: { input: 1, cacheRead: 0, cacheWrite: 0 },
          }),
        };
      },
    },
  } as unknown as ReviewContext;
  const state = createReviewerState();
  const review = createPiReviewer(ctx, state);
  const input = {
    command: "danger",
    rule: rule(),
    reviewer: reviewerConfig(),
    reviewEvidence: { projectInstructions: false },
    signal: controller.signal,
  };
  const result = await review(input);
  assert.equal(result.ok, false);
  assert.equal(state.lineage, undefined);
  const recovery = await review({ ...input, signal: undefined });
  assert.equal(recovery.ok, true);
  const recoveredSession = state.lineage!.sessionId;
  resolveAbandoned({
    stopReason: "stop",
    content: [{ type: "text", text: '{"decision":"approve","reason":"late"}' }],
    usage: { input: 1, cacheRead: 0, cacheWrite: 0 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.lineage!.sessionId, recoveredSession);
  assert.equal(calls, 2);
});

test("fresh evidence overflow routes through confirmation or blocks without UI", async () => {
  const largeCommand = `danger${"x".repeat(500_000)}`;
  for (const hasUI of [true, false]) {
    for (const allow of hasUI ? [true, false] : [false]) {
      const ui = context({
        hasUI,
        ui: {
          confirm: async (...args: unknown[]) => {
            uiCalls.push(args);
            return allow;
          },
        } as any,
      });
      const uiCalls: unknown[][] = [];
      const reviewer = createPiReviewer(
        {
          cwd: "/repo",
          model: { provider: "p", id: "m", api: "fake", baseUrl: "", contextWindow: 128_000 },
          isProjectTrusted: () => true,
          sessionManager: { getSessionId: () => "main", buildSessionProjection: () => ({ entries: [] }) },
          modelRegistry: {
            find: () => undefined,
            streamSimple: () => {
              throw Error("overflow must not call provider");
            },
          },
        } as unknown as ReviewContext,
        createReviewerState(),
      );
      const decision = await handleToolCall(
        { toolName: "bash", input: { command: largeCommand } },
        ui.ctx,
        () => config(ruleSet(), true),
        { review: reviewer },
      );
      if (hasUI) {
        assert.match(String(uiCalls[0]?.[1]), /Automatic review failed: compact review evidence/);
        if (allow) assert.equal(decision, undefined);
        else assert.match(decision!.reason, /user declined/);
      } else assert.match(decision!.reason, /automatic review failed: compact review evidence/);
    }
  }
});

test("project instruction files stay system-only, are trust-gated, and edits reset reuse", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "approval-instructions-"));
  try {
    const path = join(cwd, "AGENTS.md");
    writeFileSync(path, "Never run destructive commands.\n");
    let trusted = true;
    const calls: any[] = [];
    const ctx = {
      cwd,
      model: { provider: "p", id: "m", api: "fake", baseUrl: "", contextWindow: 128_000 },
      isProjectTrusted: () => trusted,
      sessionManager: {
        getSessionId: () => "main",
        buildSessionProjection: () => ({
          entries: [
            { sourceEntry: { type: "message", id: "u" }, messages: [{ role: "user", content: "please do it" }] },
          ],
        }),
      },
      modelRegistry: {
        find: () => undefined,
        streamSimple: (_: unknown, context: any, options: any) => {
          calls.push({ context: structuredClone(context), options });
          return {
            result: async () => ({
              stopReason: "stop",
              content: [{ type: "text", text: '{"decision":"ask_user","reason":"Confirm."}' }],
              usage: { input: 1, cacheRead: 0, cacheWrite: 0 },
            }),
          };
        },
      },
    } as unknown as ReviewContext;
    const reviewer = createPiReviewer(ctx, createReviewerState());
    const input = {
      command: "danger",
      rule: rule(),
      reviewer: reviewerConfig(),
      reviewEvidence: { projectInstructions: true },
      signal: undefined,
    };
    assert.equal((await reviewer(input)).ok, true);
    assert.match(calls[0].context.systemPrompt, /Never run destructive commands/);
    assert.doesNotMatch(calls[0].context.messages[0].content[0].text, /Never run destructive commands/);
    trusted = false;
    await reviewer(input);
    assert.doesNotMatch(calls.at(-1).context.systemPrompt, /Never run destructive commands/);
    trusted = true;
    writeFileSync(path, "Updated: never run anything.\n");
    await reviewer(input);
    assert.match(calls.at(-1).context.systemPrompt, /Updated: never run anything/);
    assert.equal(calls.at(-1).context.messages.length, 1);
    rmSync(path);
    mkdirSync(path);
    const failed = await reviewer(input);
    assert.equal(failed.ok, false);
    assert.equal(calls.length, 3);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("factory widget shows reviewing, then approved or blocked, and clears after 2000 ms", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let finish!: (approved: boolean) => void;
  const approve = await factoryHarness(
    t,
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = approve.invoke();
  assert.deepEqual(
    approve.setWidget.mock.calls.map((call) => call.arguments),
    [["auto-approval:1", ["auto-approval: reviewing [danger]"]]],
  );
  finish(true);
  assert.equal(await pending, undefined);
  assert.deepEqual(approve.setWidget.mock.calls.at(-1)?.arguments, [
    "auto-approval:1",
    ["auto-approval: approved [danger]"],
  ]);
  mock.timers.tick(1999);
  assert.equal(approve.setWidget.mock.calls.length, 2);
  mock.timers.tick(1);
  assert.deepEqual(approve.setWidget.mock.calls.at(-1)?.arguments, ["auto-approval:1", undefined]);

  const deny = await factoryHarness(t, async () => false);
  assert.match(((await deny.invoke()) as { reason: string }).reason, /user declined/);
  assert.deepEqual(
    deny.setWidget.mock.calls.map((call) => call.arguments),
    [
      ["auto-approval:1", ["auto-approval: reviewing [danger]"]],
      ["auto-approval:1", ["auto-approval: blocked [danger]"]],
    ],
  );
  mock.timers.tick(2000);
  assert.deepEqual(deny.setWidget.mock.calls.at(-1)?.arguments, ["auto-approval:1", undefined]);
});

test("ui.status false suppresses factory widget calls without changing enforcement", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const declinedConfirm = mock.fn(async () => false);
  const declined = await factoryHarness(t, declinedConfirm, { uiStatus: false });
  assert.match(((await declined.invoke()) as { reason: string }).reason, /user declined/);
  assert.equal(declinedConfirm.mock.callCount(), 1);

  const approvedConfirm = mock.fn(async () => true);
  const approved = await factoryHarness(t, approvedConfirm, { uiStatus: false });
  assert.equal(await approved.invoke(), undefined);
  assert.equal(approvedConfirm.mock.callCount(), 1);

  assert.equal(declined.setWidget.mock.callCount() + approved.setWidget.mock.callCount(), 0);
});

test("starter rules match intended commands", () => {
  const raw = JSON.parse(readFileSync(new URL("../examples/auto-permissions.json", import.meta.url), "utf8"));
  const parsed = parseConfig(raw, "example");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  for (const command of ["git push origin main", "rm -rf /tmp/x", "rm -fr /tmp/x", "terraform apply"])
    assert.ok(matchRule(command, parsed.rules));
  for (const command of ["git status", "rm -r /tmp/x", "terraform plan"])
    assert.equal(matchRule(command, parsed.rules), undefined);
});
