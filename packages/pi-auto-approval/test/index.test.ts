import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import test, { afterEach, mock } from "node:test";
import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import type { ConfigResult, PermissionRule, ReviewerConfig } from "../src/config.ts";
import { parseConfig, SEED_CONFIG } from "../src/config.ts";
import { parsePermissionRule } from "../src/rules.ts";
import { BUDGET_EXCEEDED_ERROR } from "../src/review/protocol.ts";
import type { ConfigLoader, GateContext, GateDeps, ReviewContext, ReviewInput } from "../src/index.ts";
import { createPiReviewer, createReviewerState, handleToolCall } from "../src/index.ts";

afterEach(() => mock.timers.reset());

import type {
  ExtensionAPI,
  ExtensionHandler,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

type ToolCallHandler = ExtensionHandler<ToolCallEvent, ToolCallEventResult>;

const rule = (level: "deny" | "ask" | "allow" = "ask", scope: "global" | "project" = "global"): PermissionRule => {
  const parsed = parsePermissionRule("Bash(danger*)", level, `${scope}.json`, scope, "test rule");
  if (!parsed.ok) throw new Error(parsed.error);
  return { ...parsed.value, label: "danger command" };
};
const ruleSet = (level: "deny" | "ask" | "allow" = "ask"): PermissionRule[] => [rule(level)];
const config = (rules = ruleSet(), reviewMode: "manual" | "auto" = "manual"): ConfigResult => ({
  ok: true,
  rules,
  enabled: true,
  reviewMode,
  ui: { status: true, placement: "widget" },
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
    isProjectTrusted: () => true,
    ui: {
      confirm: async (...args) => {
        calls.push(args);
        return true;
      },
      notify: () => {},
    },
    ...overrides,
  };
  return { ctx, calls };
}
const event = (command: unknown = "dangerous") => ({ toolName: "bash", input: { command } });

test("allowing codemode does not allow denied nested tool calls", async () => {
  const settings = parseConfig({ permissions: { allow: ["codemode"], deny: ["Bash(danger*)", "Read(./.env)", "Edit(./protected.txt)", "Write(./protected.txt)"] } }, "test.json");
  assert.equal(settings.ok, true);
  const { ctx, calls } = context();
  const load = () => settings;
  const parent = { toolName: "codemode", toolCallId: "parent", input: { code: "await tools.bash({ command: 'danger' })" } };
  assert.equal(await handleToolCall(parent, ctx, load), undefined);
  for (const [toolName, input] of [
    ["bash", { command: "danger" }],
    ["read", { path: "/tmp/.env" }],
    ["edit", { path: "/tmp/protected.txt", edits: [] }],
    ["write", { path: "/tmp/protected.txt", content: "blocked" }],
  ] as const) {
    const child = { toolName, input, parentToolCallId: "parent" };
    assert.equal((await handleToolCall(child, ctx, load))?.block, true, toolName);
  }
  assert.equal(calls.length, 0, "denials must not offer an approval override");
});

test("non-bash loads config and confirms an unmatched call in manual mode", async () => {
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
      { status: (report) => statuses.push(typeof report === "string" ? report : report.state) },
    ),
    undefined,
  );
  assert.equal(
    await handleToolCall(
      event("echo ok"),
      ctx,
      () => {
        loads++;
        return config([]);
      },
      { status: (report) => statuses.push(typeof report === "string" ? report : report.state) },
    ),
    undefined,
  );
  assert.equal(loads, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(statuses, ["approval-required", "approved", "approval-required", "approved"]);
});

const parsedRule = (raw: string, level: "deny" | "ask" | "allow" = "deny"): PermissionRule => {
  const parsed = parsePermissionRule(raw, level, "global.json", "global", "test rule");
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};
const approving = (calls: { count: number }) => async (input: ReviewInput) => {
  calls.count++;
  return { ok: true as const, verdict: { decision: "approve" as const, reason: "ok" } };
};

test("every exposed tool is matched by the same permission rules", async () => {
  const rules = [parsedRule("Read(./.env)"), parsedRule("Edit(./secrets/**)"), parsedRule("CronCreate")];
  const { ctx, calls } = context();
  const denied = async (toolName: string, input: unknown) => (await handleToolCall({ toolName, input }, ctx, () => config(rules), {}))?.reason;
  assert.equal(await denied("read", { path: ".env" }), "Blocked by auto-approval (Read(./.env), global.json)");
  assert.equal(await denied("write", { path: "secrets/key.pem", content: "x" }), "Blocked by auto-approval (Edit(./secrets/**), global.json)");
  assert.equal(await denied("edit", { path: "secrets/key.pem", edits: [] }), "Blocked by auto-approval (Edit(./secrets/**), global.json)");
  assert.equal(await denied("CronCreate", {}), "Blocked by auto-approval (CronCreate, global.json)");
  assert.equal(calls.length, 0);
});

test("explicit file allow bypasses review without the bash compound check, and non-string paths never match", async () => {
  const review = { count: 0 };
  const { ctx, calls } = context();
  const allowRules = [parsedRule("Read(./notes&;$(x).md)", "allow"), parsedRule("Read(./.env)", "allow")];
  assert.equal(await handleToolCall({ toolName: "read", input: { path: "notes&;$(x).md" } }, ctx, () => config(allowRules, "auto"), { review: approving(review) }), undefined);
  assert.equal(review.count, 0);
  assert.equal(await handleToolCall({ toolName: "read", input: { path: 5 } }, ctx, () => config(allowRules, "auto"), { review: approving(review) }), undefined);
  assert.equal(review.count, 1, "non-string path is unmatched and goes to review, never allow");
  assert.equal(calls.length, 0);
});

test("unmatched non-bash review receives the tool identity and complete arguments", async () => {
  const review = { count: 0 };
  const received: ReviewInput[] = [];
  const { ctx, calls } = context();
  const args = { path: "notes.md", content: "z".repeat(3000) };
  const deps = { review: async (input: ReviewInput) => { received.push(input); return approving(review)(input); } };
  assert.equal(await handleToolCall({ toolName: "write", input: args }, ctx, () => config([], "auto"), deps), undefined);
  assert.equal(received[0]?.tool, "write");
  assert.deepEqual(received[0]?.arguments, args);
  assert.equal(received[0]?.command, undefined);
  assert.equal(calls.length, 0);
});

test("unmatched non-bash review outcomes route to confirmation or block; no UI blocks ask", async () => {
  const input = { path: "notes.md", content: "ok" };
  const outcomes: Array<{ name: string; result: unknown; prompts: number; reason?: string }> = [
    { name: "failure", result: { ok: false, error: "reviewer unavailable" }, prompts: 1 },
    { name: "ask_user", result: { ok: true, verdict: { decision: "ask_user", reason: "Check." } }, prompts: 1 },
    { name: "budget", result: { ok: false, error: BUDGET_EXCEEDED_ERROR }, prompts: 1 },
    { name: "revise", result: { ok: true, verdict: { decision: "revise", reason: "Narrow it." } }, prompts: 0, reason: "Reviewer requested a revision: Narrow it." },
    { name: "cancelled", result: { ok: false, cancelled: true, error: "cancelled" }, prompts: 0, reason: "Review cancelled" },
  ];
  for (const outcome of outcomes) {
    const { ctx, calls } = context();
    const decision = await handleToolCall({ toolName: "write", input }, ctx, () => config([], "auto"), { review: async () => outcome.result as never });
    assert.equal(calls.length, outcome.prompts, outcome.name);
    if (outcome.reason) assert.equal(decision?.reason, outcome.reason, outcome.name);
  }
  const noUi = context({ hasUI: false });
  const blocked = await handleToolCall({ toolName: "write", input }, noUi.ctx, () => config([], "auto"), { review: async () => ({ ok: true, verdict: { decision: "ask_user", reason: "Check." } }) as never });
  assert.equal(blocked?.reason, "Reviewer needs user approval: Check.");
  assert.equal(noUi.calls.length, 0);
});

test("non-bash prompt names the tool and shows its JSON input truncated at 2000 characters", async () => {
  const content = "q".repeat(3000);
  const json = JSON.stringify({ path: "notes.md", content });
  const { ctx, calls } = context();
  await handleToolCall({ toolName: "write", input: { path: "notes.md", content } }, ctx, () => config([], "manual"));
  assert.equal(calls[0]?.[0], "Approve command?");
  assert.equal(calls[0]?.[1], `Unmatched write call requires confirmation\n\nwrite ${json.slice(0, 2000)}...`);
});

test("invalid config blocks a non-bash tool before review or confirmation", async () => {
  const { ctx, calls } = context();
  const review = { count: 0 };
  const decision = await handleToolCall({ toolName: "read", input: { path: "notes.md" } }, ctx, () => ({ ok: false, error: "bad file" }), { review: approving(review) });
  assert.equal(decision?.reason, "auto-approval: invalid config - bad file. Fix it to run tools.");
  assert.equal(review.count, 0);
  assert.equal(calls.length, 0);
});

test("bash-only input and compound checks do not apply to other tools", async () => {
  const { ctx, calls } = context();
  assert.equal(await handleToolCall({ toolName: "custom", input: { command: 5 } }, ctx, () => config([], "manual")), undefined);
  assert.equal(calls.length, 1);
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

test("deny rule blocks with attribution", async () => {
  const { ctx, calls } = context();
  assert.equal(
    (await handleToolCall(event(), ctx, () => config([rule("deny")])))?.reason,
    "Blocked by auto-approval (danger command, global.json)",
  );
  assert.equal(calls.length, 0);
});

test("guarded command confirms exact raw command and label", async () => {
  const { ctx, calls } = context();
  assert.equal(await handleToolCall(event("danger; echo hi"), ctx, loadConfig), undefined);
  assert.deepEqual(calls[0]?.slice(0, 2), ["Approve command? [danger command]", "Requires confirmation (danger command, global.json)\n\ndanger; echo hi"]);
});

test("guardian abort during synchronous running report skips reviewer", async () => {
  const controller = new AbortController();
  const statuses: string[] = [];
  let reviews = 0;
  const { ctx } = context({ signal: controller.signal });
  const result = await handleToolCall(event(), ctx, () => config([], "auto"), {
    review: async () => {
      reviews++;
      return { ok: true, verdict: { decision: "approve", reason: "late" } };
    },
    status: (report) => {
      statuses.push(typeof report === "string" ? report : report.state);
      if (typeof report !== "string" && report.state === "guardian-running") controller.abort();
    },
  });
  assert.match(result!.reason, /confirmation failed/);
  assert.equal(reviews, 0);
  assert.deepEqual(statuses, ["guardian-running"]);
});

test("guardian approves without confirmation and reports review status", async () => {
  const statuses: string[] = [];
  const { ctx, calls } = context();
  let received: unknown;
  const result = await handleToolCall({ ...event(), toolCallId: "call-1" }, ctx, () => config([], "auto"), {
    review: async (input) => {
      received = input;
      return { ok: true, verdict: { decision: "approve", reason: "Authorized." } };
    },
    status: (report) => statuses.push(typeof report === "string" ? report : report.state),
  });
  assert.equal(result, undefined);
  assert.equal(calls.length, 0);
  assert.deepEqual(statuses, ["guardian-running", "approved"]);
  assert.deepEqual((received as { reviewEvidence: unknown }).reviewEvidence, { projectInstructions: false });
});

test("guardian revise blocks and ask_user confirms with the reason", async () => {
  const denied = context();
  const revised = await handleToolCall(event(), denied.ctx, () => config([], "auto"), {
    review: async () => ({ ok: true, verdict: { decision: "revise", reason: "Target mismatch." } }),
  });
  assert.match(revised!.reason, /Reviewer requested a revision: Target mismatch/);
  const askCalls = context();
  assert.equal(
    await handleToolCall(event("dangerous exact"), askCalls.ctx, () => config([], "auto"), {
      review: async () => ({ ok: true, verdict: { decision: "ask_user", reason: "Confirm target." } }),
    }),
    undefined,
  );
  assert.match(String(askCalls.calls[0]?.[1]), /Reviewer needs user approval: Confirm target/);
  assert.match(String(askCalls.calls[0]?.[1]), /dangerous exact/);
});

test("guardian failure falls back to confirmation or blocks without UI", async () => {
  const ui = context();
  assert.equal(
    await handleToolCall(event(), ui.ctx, () => config([], "auto"), {
      review: async () => ({ ok: false, error: "timeout" }),
    }),
    undefined,
  );
  assert.match(String(ui.calls[0]?.[1]), /Automatic review failed: timeout/);
  const noUi = context({ hasUI: false });
  assert.match(
    (await handleToolCall(event(), noUi.ctx, () => config([], "auto"), {
      review: async () => ({ ok: false, error: "timeout" }),
    }))!.reason,
    /Automatic review failed: timeout/,
  );
});

test("no UI blocks guarded command", async () => {
  const statuses: string[] = [];
  const noUi = context({ hasUI: false });
  assert.match(
    (await handleToolCall(event(), noUi.ctx, loadConfig, { status: (report) => statuses.push(typeof report === "string" ? report : report.state) }))!.reason,
    /Requires confirmation/,
  );
  assert.equal(noUi.calls.length, 0);
  assert.equal(statuses.length, 0);
});

test("trusted guarded rule bypasses confirmation and reports status", async () => {
  const statuses: string[] = [];
  const { ctx, calls } = context();
  assert.equal(
    await handleToolCall(event(), ctx, () => config([rule("allow", "global")]), {

      status: (report) => statuses.push(typeof report === "string" ? report : report.state),
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
    await handleToolCall(event(), noUi.ctx, () => config([rule("allow", "global")]), {

      status: (report) => statuses.push(typeof report === "string" ? report : report.state),
    }),
    undefined,
  );
  assert.equal(noUi.calls.length, 0);
  assert.equal(statuses.length, 0);
});

test("config loader abort after returning blocks unmatched command", async () => {
  const controller = new AbortController();
  const statuses: string[] = [];
  const { ctx, calls } = context({ signal: controller.signal });
  const result = await handleToolCall(event("echo ok"), ctx, () => { controller.abort(); return config(); }, {

    status: (report) => statuses.push(typeof report === "string" ? report : report.state),
  });
  assert.match(result!.reason, /confirmation failed/);
  assert.equal(calls.length, 0);
  assert.equal(statuses.length, 0);
});

test("allow blocks when aborted while sampling project trust", async () => {
  const controller = new AbortController();
  const { ctx, calls } = context({ signal: controller.signal, isProjectTrusted: () => { controller.abort(); return true; } });
  const result = await handleToolCall(event(), ctx, () => config([rule("allow", "global")]), {

  });
  assert.match(result!.reason, /confirmation failed/);
  assert.equal(calls.length, 0);
});

test("trusted guarded rule blocks when aborted during status reporting", async () => {
  const controller = new AbortController();
  const { ctx, calls } = context({ signal: controller.signal });
  const result = await handleToolCall(event(), ctx, () => config([rule("allow", "global")]), {

    status: () => {
      controller.abort();
    },
  });
  assert.match(result!.reason, /confirmation failed/);
  assert.equal(calls.length, 0);
});

test("untrusted project allow confirms; deny cannot bypass", async () => {
  const statuses: string[] = [];
  const { ctx, calls } = context({ isProjectTrusted: () => false });
  assert.equal(
    await handleToolCall(event(), ctx, () => config([rule("allow", "project")]), {
      status: (report) => statuses.push(typeof report === "string" ? report : report.state),
    }),
    undefined,
  );
  assert.equal(calls.length, 1);
  const blocked = await handleToolCall(event(), ctx, () => config([rule("deny")]), {

    status: (report) => statuses.push(typeof report === "string" ? report : report.state),
  });
  assert.equal(blocked?.reason, "Blocked by auto-approval (danger command, global.json)");
  assert.deepEqual(statuses, ["approval-required", "approved", "blocked"]);
});

test("status disabled hides reports without changing enforcement", async () => {
  const statuses: string[] = [];
  const hiddenConfig = (rules = ruleSet()): ConfigResult => {
    const loaded = config(rules);
    return loaded.ok ? { ...loaded, ui: { status: false, placement: "widget" } } : loaded;
  };
  const denied = context({ ui: { confirm: async () => false, notify: () => {} } });
  const result = await handleToolCall(event(), denied.ctx, () => hiddenConfig(), {
    status: (report) => statuses.push(typeof report === "string" ? report : report.state),
  });
  assert.match(result!.reason, /user declined/);
  assert.equal(statuses.length, 0);

  const trusted = context();
  assert.equal(
    await handleToolCall(event(), trusted.ctx, () => hiddenConfig([rule("allow", "global")]), {

      status: (report) => statuses.push(typeof report === "string" ? report : report.state),
    }),
    undefined,
  );
  assert.equal(trusted.calls.length, 0);
  assert.equal(statuses.length, 0);

  const convention = await handleToolCall(event(), trusted.ctx, () => hiddenConfig([rule("deny")]), {

    status: (report) => statuses.push(typeof report === "string" ? report : report.state),
  });
  assert.equal(convention?.reason, "Blocked by auto-approval (danger command, global.json)");
  assert.equal(statuses.length, 0);
});

test("project trust failures ignore project allow and fall back to confirmation", async () => {
  const { ctx, calls } = context({ isProjectTrusted: () => { throw Error("trust failed"); } });
  assert.equal(
    await handleToolCall(event(), ctx, () => config([rule("allow", "project")]), {

    }),
    undefined,
  );
  assert.equal(calls.length, 1);
  assert.equal(
    await handleToolCall(event(), ctx, () => config([rule("allow", "project")]), {

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
  const denied = context({ ui: { confirm: async () => false, notify: () => {} } });
  assert.match((await handleToolCall(event(), denied.ctx, loadConfig, { status: throwing }))!.reason, /user declined/);
  assert.equal(
    (await handleToolCall(event(), context().ctx, () => config([rule("deny")]), { status: throwing }))?.reason,
    "Blocked by auto-approval (danger command, global.json)",
  );
});

test("user denial blocks", async () => {
  const statuses: string[] = [];
  const denied = context({ ui: { confirm: async () => false, notify: () => {} } });
  assert.match(
    (await handleToolCall(event(), denied.ctx, loadConfig, { status: (report) => statuses.push(typeof report === "string" ? report : report.state) }))!.reason,
    /user declined/,
  );
  assert.deepEqual(statuses, ["approval-required", "blocked"]);
});

test("confirmation throwing blocks", async () => {
  const statuses: string[] = [];
  const failed = context({
    ui: {
      confirm: async () => {
        throw Error();
      },
      notify: () => {},
    },
  });
  assert.match(
    (await handleToolCall(event(), failed.ctx, loadConfig, { status: (report) => statuses.push(typeof report === "string" ? report : report.state) }))!.reason,
    /confirmation failed/,
  );
  assert.deepEqual(statuses, ["approval-required", "blocked"]);
});

test("already-aborted signal blocks without prompting", async () => {
  const statuses: string[] = [];
  const controller = new AbortController();
  controller.abort();
  const aborted = context({ signal: controller.signal });
  assert.equal(
    (await handleToolCall(event(), aborted.ctx, loadConfig, { status: (report) => statuses.push(typeof report === "string" ? report : report.state) }))?.reason,
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
      notify: () => {},
    },
  });
  assert.match(
    (await handleToolCall(event(), during.ctx, loadConfig, { status: (report) => statuses.push(typeof report === "string" ? report : report.state) }))!.reason,
    /review cancelled/,
  );
  assert.deepEqual(statuses, ["approval-required"]);
});

test("abort during approved status reporting blocks confirmed command", async () => {
  const statuses: string[] = [];
  const controller = new AbortController();
  const { ctx, calls } = context({ signal: controller.signal });
  const result = await handleToolCall(event(), ctx, loadConfig, {
    status: (state) => {
      statuses.push(typeof state === "string" ? state : state.state);
      if (state.state === "approved") controller.abort();
    },
  });
  assert.match(result!.reason, /confirmation failed/);
  assert.equal(calls.length, 1);
  assert.deepEqual(statuses, ["approval-required", "approved"]);
});

test("non-boolean confirmation result blocks", async () => {
  const invalid = context({ ui: { confirm: async () => undefined as unknown as boolean, notify: () => {} } });
  assert.notEqual(await handleToolCall(event(), invalid.ctx, loadConfig), undefined);
});

test("factory registers tool, session reset and permissions command", async (t) => {
  const { registrations, commands } = await factoryHarness(t, async () => true);
  assert.equal(registrations.length, 4);
  assert.ok(commands.permissions);
});

test("factory harnesses restore HOME before returning, even when several share one test", async (t) => {
  const originalHome = process.env.HOME;
  const first = await factoryHarness(t, async () => true);
  assert.equal(process.env.HOME, originalHome);
  const second = await factoryHarness(t, async () => true);
  assert.equal(process.env.HOME, originalHome);
  assert.notEqual(first.globalDir, second.globalDir);
  assert.equal(await first.invoke(), undefined);
  assert.equal(await second.invoke(), undefined);
  assert.equal(process.env.HOME, originalHome);
});

test("factory ignores trusted-ops changes and always confirms ask rules", async (t) => {
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
  assert.equal(confirmations, 1);
  writeFileSync(trustedPath, "\n");
  assert.equal(await invoke(), undefined);
  assert.equal(confirmations, 2);
  writeFileSync(trustedPath, "git\n");
  await import("node:fs").then(({ unlinkSync }) => unlinkSync(trustedPath));
  assert.equal(await invoke(), undefined);
  assert.equal(confirmations, 3);
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
  const registrations: Array<{ eventName: string; callback: (...args: any[]) => unknown }> = [];
  const commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
  const pi = {
    on: ((eventName: "tool_call", callback: ToolCallHandler) => {
      registrations.push({ eventName, callback });
      return () => {};
    }) as ExtensionAPI["on"],
    registerCommand: ((name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) => { commands[name] = options; }) as ExtensionAPI["registerCommand"],
  } as ExtensionAPI;
  const cwd = mkdtempSync(join(tmpdir(), "auto-approval-"));
  const home = join(cwd, "home");
  const globalDir = join(home, ".pi", "pi-auto-approval");
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    mkdirSync(globalDir, { recursive: true });
    autoApproval(pi);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(
    join(globalDir, "auto-permissions.json"),
    JSON.stringify({
      enabled: true,
      reviewMode: guardian ? "auto" : "manual",
      permissions: guardian ? {} : { ask: ["Bash(danger*)"] },
      ui: { status: uiStatus, placement: "widget" },
    }),
  );
  const setWidget = mock.fn((_key: string, _content: string[] | undefined) => {});
  const model = { provider: "fake", id: "reviewer" };
  const prompts: string[] = [];
  const streamOptions: unknown[] = [];
  const snapshots: Array<{ context: unknown; options: unknown }> = [];
  const ctx = {
    cwd,
    mode: "tui",
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
    ui: { confirm, setWidget, notify: () => {} },
  } as unknown as Parameters<ToolCallHandler>[1];
  const invoke = (confirmPrompt = confirm, toolCallId?: string) =>
    registrations.find((registration) => registration.eventName === "tool_call")!.callback({ ...event(), toolCallId } as ToolCallEvent, {
      ...ctx,
      ui: { ...ctx.ui, confirm: confirmPrompt },
    });
  const menu = (selection: string | undefined) => commands.permissions!.handler("", { ...ctx, ui: { ...ctx.ui, select: async () => selection } });
  const reset = (reason: string) => registrations.find((registration) => registration.eventName === "session_start")!.callback({ reason }, ctx);
  const invokeTool = (toolName: string, input: unknown, toolCallId: string, confirmPrompt = confirm) =>
    registrations.find((registration) => registration.eventName === "tool_call")!.callback({ type: "tool_call", toolName, toolCallId, input }, {
      ...ctx,
      ui: { ...ctx.ui, confirm: confirmPrompt },
    });
  return { cwd, globalDir, ctx, registrations, commands, menu, reset, setWidget, invoke, invokeTool, prompts, streamOptions, snapshots };
}

test("factory gates a non-bash call under the same single confirmation lock", async (t) => {
  let release!: (approved: boolean) => void;
  const prompts: unknown[][] = [];
  const h = await factoryHarness(t, (...args: unknown[]) => {
    prompts.push(args);
    return new Promise<boolean>((resolve) => { release = resolve; });
  });
  const first = h.invokeTool("read", { path: "README.md" }, "read-1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prompts.length, 1);
  assert.deepEqual(await h.invokeTool("write", { path: "x.md", content: "" }, "write-2"), {
    block: true,
    reason: "Unmatched write call requires confirmation (confirmation failed)",
  });
  release(true);
  assert.equal(await first, undefined);
  assert.equal(prompts.length, 1);
});

test("factory reviews an unmatched non-bash call with full arguments and shows it in the widget", async (t) => {
  const content = "z".repeat(3000);
  const h = await factoryHarness(t, async () => true, { guardian: true });
  assert.equal(await h.invokeTool("write", { path: "notes.md", content }, "write-review"), undefined);
  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0]!, /"tool": "write"/);
  assert.ok(h.prompts[0]!.includes(content), "reviewer receives the complete content, not the display excerpt");
  const widgets = h.setWidget.mock.calls.map((call) => JSON.stringify(call.arguments));
  assert.ok(widgets.length > 0);
  assert.ok(widgets.some((text) => text.includes("Unmatched write call")), "non-bash status uses the widget fallback");
});

test("guardian ask_user without UI blocks; parent cancellation never prompts", async () => {
  const noUi = context({ hasUI: false });
  const needsUser = await handleToolCall(event(), noUi.ctx, () => config([], "auto"), {
    review: async () => ({ ok: true, verdict: { decision: "ask_user", reason: "Confirm this." } }),
  });
  assert.equal(needsUser?.block, true);
  assert.match(needsUser!.reason, /Reviewer needs user approval: Confirm this/);
  assert.equal(noUi.calls.length, 0);

  const controller = new AbortController();
  const cancelled = context({ signal: controller.signal });
  const result = await handleToolCall(event(), cancelled.ctx, () => config([], "auto"), {
    review: async () => {
      controller.abort();
      return { ok: false, error: "cancelled" };
    },
  });
  assert.match(result!.reason, /confirmation failed/);
  assert.equal(cancelled.calls.length, 0);
});

test("guardian cancellation after automatic approval blocks", async () => {
  const controller = new AbortController();
  const statuses: string[] = [];
  const { ctx, calls } = context({ signal: controller.signal });
  const result = await handleToolCall(event(), ctx, () => config([], "auto"), {
    review: async () => ({ ok: true, verdict: { decision: "approve", reason: "Allowed." } }),
    status: (state) => {
      statuses.push(typeof state === "string" ? state : state.state);
      if (state.state === "approved") controller.abort();
    },
  });
  assert.match(result!.reason, /confirmation failed/);
  assert.equal(calls.length, 0);
  assert.deepEqual(statuses, ["guardian-running", "approved"]);
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
    const { ctx, calls } = context({ ui: { confirm, notify: () => {} } });
    const result = await handleToolCall(event(), ctx, () => config([], "auto"), {
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
    await handleToolCall(event(), ctx, () => config([rule("allow", "global")], "auto"), {
      ...deps,

    }),
    undefined,
  );
  assert.equal(
    (await handleToolCall(event(), ctx, () => config([rule("deny")], "auto"), deps))?.reason,
    "Blocked by auto-approval (danger command, global.json)",
  );
  assert.equal(await handleToolCall(event("echo safe"), ctx, () => config([], "auto"), deps), undefined);
  assert.equal(reviews, 1, "unmatched auto command must be reviewed");
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
      assert.match(String(message), /Reviewer needs user approval: Confirm the target/);
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
    await handleToolCall(event(), ui.ctx, () => config([], "auto"), { review: async () => missingActive }),
    undefined,
  );
  assert.match(String(ui.calls[0]?.[1]), /Automatic review failed: review model not found/);
  assert.equal(
    await handleToolCall(event(), ui.ctx, () => config([], "auto"), { review: async () => missingSelected }),
    undefined,
  );

  const noUi = context({ hasUI: false });
  const blocked = await handleToolCall(event(), noUi.ctx, () => config([], "auto"), {
    review: async () => missingSelected,
  });
  assert.match(blocked!.reason, /Automatic review failed: review model not found/);
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
    const text = evidenceText(request).replaceAll("\\n", "\n");
    const records = [...text.matchAll(/^\s*(\{\s*"source"\s*:[^\n]+)$/gm)].map((match) => JSON.parse(match[1]!));
    assert.ok(records.length > 0, "comparison must extract actual evidence");
    return records;
  };
  const latestAction = (request: any) => {
    const text = evidenceText(request);
    return (
      text.match(/<LATEST_PROPOSED_ACTION>([\s\S]*?)<\/LATEST_PROPOSED_ACTION>/)?.[1]
    );
  };
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(extractEvidence(reusedRequests[i]), extractEvidence(freshRequests[i]), `evidence at step ${i}`);
    assert.ok(latestAction(reusedRequests[i]), "comparison must extract an action card");
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
        () => config([], "auto"),
        { review: reviewer },
      );
      if (hasUI) {
        assert.match(String(uiCalls[0]?.[1]), /Automatic review failed: compact review evidence/);
        if (allow) assert.equal(decision, undefined);
        else assert.match(decision!.reason, /user declined/);
      } else assert.match(decision!.reason, /Automatic review failed: compact review evidence/);
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
    [["auto-approval:1", ["auto-approval: reviewing [Bash(danger*)]"], { placement: "aboveEditor" }]],
  );
  finish(true);
  assert.equal(await pending, undefined);
  assert.deepEqual(approve.setWidget.mock.calls.at(-1)?.arguments, [
    "auto-approval:1",
    ["auto-approval: approved [Bash(danger*)]"],
    { placement: "aboveEditor" },
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
      ["auto-approval:1", ["auto-approval: reviewing [Bash(danger*)]"], { placement: "aboveEditor" }],
      ["auto-approval:1", ["auto-approval: blocked [Bash(danger*)]"], { placement: "aboveEditor" }],
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

test("shipped example is the exact starter config", () => {
  const raw = JSON.parse(readFileSync(new URL("../examples/auto-permissions.json", import.meta.url), "utf8"));
  assert.deepEqual(raw, { permissions: SEED_CONFIG.permissions });
  const parsed = parseConfig(raw, "example");
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.rules.length, 23);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("factory session_start clears awaited explicit off and auto choices for all five reasons", async (t) => {
  const h = await factoryHarness(t, async () => false);
  for (const reason of ["startup", "reload", "new", "resume", "fork"]) {
    await h.menu("Auto review");
    await h.menu("Protection off");
    assert.equal(await h.invoke(), undefined);
    await h.reset(reason);
    assert.match(((await h.invoke()) as { reason: string }).reason, /user declined/);
    assert.equal(h.prompts.length, 0, "reset must restore saved manual review, not auto");
  }
});

test("menu cancellation settles an abort-ignoring dialog and retains its lock until actual settlement", async (t) => {
  for (const selection of ["Protection off", "Auto review", "Clear session choices / reload"]) {
    const old = deferred<boolean>();
    const opened = deferred<void>();
    const h = await factoryHarness(t, async () => { opened.resolve(); return old.promise; });
    if (selection === "Clear session choices / reload") await h.menu("Auto review");
    if (selection === "Clear session choices / reload") {
      writeFileSync(join(h.globalDir, "auto-permissions.json"), JSON.stringify({ reviewMode: "manual", permissions: {} }));
      await h.menu("Manual review");
      writeFileSync(join(h.globalDir, "auto-permissions.json"), JSON.stringify({ reviewMode: "auto", permissions: {} }));
    }
    const pending = h.invoke();
    await opened.promise;
    await h.menu(selection);
    assert.match(((await pending) as { reason: string }).reason, /confirmation failed/);
    assert.equal(h.setWidget.mock.calls.some((call) => JSON.stringify(call.arguments).includes("Cancelled")), true);
    const published = h.setWidget.mock.callCount();
    if (selection === "Protection off") {
      assert.equal(await h.invoke(), undefined, "off retry is a fresh permitted attempt");
      await h.menu("Protection on");
    }
    let newDialog = false;
    // Ask still owns human approval even when mode switched to auto.
    writeFileSync(join(h.globalDir, "auto-permissions.json"), JSON.stringify({ permissions: { ask: ["Bash(danger*)"] } }));
    assert.match(((await h.invoke(async () => { newDialog = true; return true; })) as { reason: string }).reason, /confirmation failed/);
    assert.equal(newDialog, false, "unresolved old dialog must retain its lock");
    old.resolve(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.setWidget.mock.calls.slice(published).some((call) => JSON.stringify(call.arguments).includes("approved")), false, "late approval must not publish");
    assert.equal(await h.invoke(async () => true), undefined);
  }
});

test("menu cancels active and queued model reviews without late approval or fallback", async (t) => {
  for (const selection of ["Protection off", "Manual review"]) {
    const h = await factoryHarness(t, async () => assert.fail("cancelled review cannot prompt"), { guardian: true });
    const started = deferred<void>();
    const late = deferred<any>();
    let streams = 0;
    (h.ctx.modelRegistry as any).streamSimple = () => {
      streams++; started.resolve();
      return { result: () => late.promise };
    };
    const active = h.invoke();
    await started.promise;
    const queued = h.invoke();
    await h.menu(selection);
    for (const pending of [active, queued]) assert.match(((await pending) as { reason: string }).reason, /confirmation failed/);
    const cancelledCalls = h.setWidget.mock.calls.filter((call) => JSON.stringify(call.arguments).includes("Cancelled"));
    assert.equal(cancelledCalls.length, 2, "each cancelled owner publishes exactly one cancellation");
    assert.deepEqual(new Set(cancelledCalls.map((call) => call.arguments[0])), new Set(["auto-approval:1", "auto-approval:2"]));
    assert.equal(streams, 1, "queued cancelled review cannot call provider");
    late.resolve({ stopReason: "stop", content: [{ type: "text", text: '{"decision":"approve","reason":"late"}' }] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.setWidget.mock.calls.some((call) => JSON.stringify(call.arguments).includes("approved")), false);
    assert.equal(await h.invoke(async () => true), undefined, "retry uses new protection/mode");
  }
});

test("fallback cancellation suppresses late approval; unchanged choice and save do not cancel", async (t) => {
  const old = deferred<boolean>();
  const opened = deferred<void>();
  const h = await factoryHarness(t, async () => { opened.resolve(); return old.promise; }, { guardian: true, reply: "not JSON" });
  let settled = false;
  const pending = Promise.resolve(h.invoke()).then((result) => { settled = true; return result; }); await opened.promise;
  await h.menu("Auto review");
  await h.menu("Save settings");
  assert.equal(settled, false, "unchanged choice and saving must leave fallback pending");
  await h.menu("Protection off");
  assert.match(((await pending) as { reason: string }).reason, /confirmation failed/);
  assert.equal(h.setWidget.mock.calls.filter((call) => JSON.stringify(call.arguments).includes("Cancelled")).length, 1);
  old.resolve(true); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.setWidget.mock.calls.some((call) => JSON.stringify(call.arguments).includes("approved")), false);
});

test("external edits do not cancel pending review and session overrides persist until clear", async (t) => {
  const h = await factoryHarness(t, async () => false, { guardian: true });
  const started = deferred<void>(); const reply = deferred<any>();
  (h.ctx.modelRegistry as any).streamSimple = () => { started.resolve(); return { result: () => reply.promise }; };
  const pending = h.invoke(); await started.promise;
  writeFileSync(join(h.globalDir, "auto-permissions.json"), "{broken");
  reply.resolve({ stopReason: "stop", content: [{ type: "text", text: '{"decision":"approve","reason":"ok"}' }] });
  assert.equal(await pending, undefined);
  assert.match(((await h.invoke()) as { reason: string }).reason, /invalid config/);
  await h.menu("Protection off");
  assert.equal(await h.invoke(), undefined);
  await h.menu("Clear session choices / reload");
  assert.match(((await h.invoke()) as { reason: string }).reason, /invalid config/);
});

test("authorization routes enforce priority, attribution, trust and suspicious allows", async () => {
  let reviews = 0; const notices: string[] = []; const prompts: string[] = [];
  let trusted = false; let trustSamples = 0;
  const { ctx } = context({ isProjectTrusted: () => { trustSamples++; return trusted; }, ui: {
    notify: (message) => { notices.push(message); },
    confirm: async (_title, message) => { prompts.push(message); return true; },
  } });
  const deps = { review: async () => { reviews++; return { ok: true as const, verdict: { decision: "approve" as const, reason: "ok" } }; } };
  for (const mode of ["manual", "auto"] as const) {
    const allow = rule("allow", "global"); const ask = rule("ask", "project"); const deny = rule("deny", "global");
    for (const rules of [[allow, ask, deny], [deny, ask, allow]]) {
      assert.match((await handleToolCall(event(), ctx, () => config(rules, mode), deps))!.reason, /danger command, global.json/);
    }
    assert.equal(await handleToolCall(event(), ctx, () => config([allow, ask], mode), deps), undefined);
    assert.match(prompts.at(-1)!, /danger command, project.json/);
    const before = prompts.length;
    assert.equal(await handleToolCall(event(), ctx, () => ({ ...config([allow], mode), ui: { status: false, placement: "widget" } }), deps), undefined);
    assert.equal(prompts.length, before);
    assert.match(notices.at(-1)!, /Allowed by rule .*global.json/);
    // Raw-text markers, including accepted false positives; not a shell-safety proof.
    for (const marker of [";", "&&", "||", "|", "&", "\n", "\r", "$(x)", "`x`", "<(x)", ">(x)", '"a; b"', "2>&1"]) {
      assert.equal(await handleToolCall(event(`danger ${marker}`), ctx, () => config([allow], mode), deps), undefined);
      assert.match(prompts.at(-1)!, /Combined or nested/);
      assert.notEqual(await handleToolCall(event(`danger ${marker}`), { ...ctx, hasUI: false }, () => config([allow], mode), deps), undefined);
    }
    assert.equal(await handleToolCall(event(), ctx, () => config([rule("allow", "project"), allow], mode), deps), undefined);
    assert.ok(notices.some((notice) => /Ignored.*project.json/.test(notice)));
    const ignored = await handleToolCall(event(), { ...ctx, hasUI: false }, () => config([rule("allow", "project")], "manual"), deps);
    assert.match(ignored!.reason, /Ignored.*project.json/);
    trusted = true;
    assert.equal(await handleToolCall(event(), ctx, () => config([rule("allow", "project")], mode), deps), undefined);
    trusted = false;
  }
  assert.equal(reviews, 0);
  assert.ok(trustSamples > 1);
});

test("off validation exception and cancelled reviewer routes fail closed", async () => {
  const { ctx, calls } = context();
  const never = () => { assert.fail("off cannot match or review"); };
  assert.equal(await handleToolCall(event(), ctx, () => ({ ...config(), enabled: false }), { matcher: never, review: never }), undefined);
  assert.equal(await handleToolCall(event(), ctx, () => { assert.fail("explicit off cannot load"); }, {}, { enabled: false }), undefined);
  assert.match((await handleToolCall(event(), ctx, () => ({ ok: false, error: "bad project" }), {}, { enabled: true }))!.reason, /bad project/);
  assert.notEqual(await handleToolCall(event(), ctx, () => config([], "auto"), { review: async () => ({ ok: false, error: "aborted", cancelled: true }) }), undefined);
  assert.equal(calls.length, 0);
});

const historyLog = () => {
  const entries: unknown[] = [];
  return { entries, history: (entry: unknown) => { entries.push(entry); return { ok: true as const }; } };
};
const approveReview = () => async () => ({ ok: true, verdict: { decision: "approve", reason: "Safe." } }) as never;
const historyFields = (row: Record<string, unknown>) => ({ tool: row.tool, command: row.command, decision: row.decision });
function historyRowsOf(cwd: string): Array<Record<string, unknown>> {
  return readFileSync(join(cwd, ".pi", "pi-auto-approval", "history.jsonl"), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}
async function settle(ticks = 10): Promise<void> {
  for (let tick = 0; tick < ticks; tick++) await Promise.resolve();
}

test("terminal history records allow, deny, and confirmation outcomes once with tool, command, and decision", async () => {
  const allowed = historyLog();
  assert.equal(await handleToolCall(event("danger now"), context().ctx, () => config(ruleSet("allow")), { history: allowed.history }), undefined);
  const denied = historyLog();
  assert.equal((await handleToolCall(event("danger now"), context().ctx, () => config(ruleSet("deny")), { history: denied.history }))?.block, true);
  const accepted = historyLog();
  assert.equal(await handleToolCall(event("danger now"), context({ ui: { confirm: async () => true, notify: () => {} } }).ctx, () => config(ruleSet("ask")), { history: accepted.history }), undefined);
  const declined = historyLog();
  assert.equal((await handleToolCall(event("danger now"), context({ ui: { confirm: async () => false, notify: () => {} } }).ctx, () => config(ruleSet("ask")), { history: declined.history }))?.block, true);
  assert.deepEqual(allowed.entries, [{ tool: "bash", command: "danger now", decision: "approved" }]);
  assert.deepEqual(denied.entries, [{ tool: "bash", command: "danger now", decision: "blocked" }]);
  assert.deepEqual(accepted.entries, [{ tool: "bash", command: "danger now", decision: "approved" }]);
  assert.deepEqual(declined.entries, [{ tool: "bash", command: "danger now", decision: "blocked" }]);
});

test("terminal history covers AI approve, revise, no-UI blocks, and failed confirmation", async () => {
  const approved = historyLog();
  assert.equal(await handleToolCall(event("ls"), context().ctx, () => config([], "auto"), { review: approveReview(), history: approved.history }), undefined);
  const revised = historyLog();
  assert.equal((await handleToolCall(event("ls"), context().ctx, () => config([], "auto"), { review: async () => ({ ok: true, verdict: { decision: "revise", reason: "Narrow it." } }) as never, history: revised.history }))?.block, true);
  const noUi = historyLog();
  assert.equal((await handleToolCall(event("danger now"), context({ hasUI: false }).ctx, () => config(ruleSet("ask")), { history: noUi.history }))?.block, true);
  const failed = historyLog();
  assert.equal((await handleToolCall(event("danger now"), context({ ui: { confirm: async () => { throw new Error("dialog broke"); }, notify: () => {} } }).ctx, () => config(ruleSet("ask")), { history: failed.history }))?.block, true);
  assert.deepEqual(approved.entries, [{ tool: "bash", command: "ls", decision: "approved" }]);
  assert.deepEqual(revised.entries, [{ tool: "bash", command: "ls", decision: "blocked" }]);
  assert.deepEqual(noUi.entries, [{ tool: "bash", command: "danger now", decision: "blocked" }]);
  assert.deepEqual(failed.entries, [{ tool: "bash", command: "danger now", decision: "blocked" }]);
});

test("terminal history uses only path for file tools, command for powershell, and empty command otherwise", async () => {
  const log = historyLog();
  const options = { review: approveReview(), history: log.history };
  await handleToolCall({ toolName: "write", input: { path: "out.txt", content: "SECRET-BODY" } }, context().ctx, () => config([], "auto"), options);
  await handleToolCall({ toolName: "read", input: { path: "notes.txt" } }, context().ctx, () => config([], "auto"), options);
  await handleToolCall({ toolName: "powershell", input: { command: "Write-Output hello" } }, context().ctx, () => config([], "auto"), options);
  await handleToolCall({ toolName: "grep", input: { pattern: "x", path: "src" } }, context().ctx, () => config([], "auto"), options);
  assert.deepEqual(log.entries, [
    { tool: "write", command: "out.txt", decision: "approved" },
    { tool: "read", command: "notes.txt", decision: "approved" },
    { tool: "powershell", command: "Write-Output hello", decision: "approved" },
    { tool: "grep", command: "", decision: "approved" },
  ]);
});

test("protection off writes no history and recorder failures never change a decision", async () => {
  const off = historyLog();
  assert.equal(await handleToolCall(event("ls"), context().ctx, () => config([], "auto"), { history: off.history }, { enabled: false }), undefined);
  assert.equal(await handleToolCall(event("ls"), context().ctx, () => ({ ...config([], "auto"), enabled: false }), { history: off.history }), undefined);
  assert.deepEqual(off.entries, []);
  const throwing = { history: () => { throw new Error("recorder down"); } };
  assert.equal(await handleToolCall(event("danger now"), context().ctx, () => config(ruleSet("allow")), throwing), undefined);
  assert.equal((await handleToolCall(event("danger now"), context().ctx, () => config(ruleSet("deny")), throwing))?.block, true);
  const failed = { history: () => ({ ok: false as const, error: "History save failed" }) };
  assert.equal(await handleToolCall(event("danger now"), context().ctx, () => config(ruleSet("allow")), failed), undefined);
});

test("handleToolCall warns exactly once for a returned or thrown history failure on approve and deny outcomes", async () => {
  const returned: GateDeps = { history: () => ({ ok: false, error: "History save failed" }) };
  const thrown: GateDeps = { history: () => { throw new Error("recorder down"); } };
  const cases: Array<{ level: "allow" | "deny"; deps: GateDeps; approved: boolean; message: RegExp }> = [
    { level: "allow", deps: returned, approved: true, message: /History save failed/ },
    { level: "deny", deps: returned, approved: false, message: /History save failed/ },
    { level: "allow", deps: thrown, approved: true, message: /recorder down/ },
    { level: "deny", deps: thrown, approved: false, message: /recorder down/ },
  ];
  for (const { level, deps, approved, message } of cases) {
    const warnings: string[] = [];
    const { ctx } = context({ ui: { confirm: async () => true, notify: (text: string, type?: string) => { if (type === "warning") warnings.push(text); } } });
    const decision = await handleToolCall(event("danger now"), ctx, () => config(ruleSet(level)), deps);
    assert.equal(decision === undefined, approved, `${level} decision is unchanged`);
    assert.equal(warnings.length, 1, `${level} warns exactly once`);
    assert.match(warnings[0]!, message);
  }
});

test("outer abort with pending confirmation records exactly one blocked entry, ignoring late approval", async (t) => {
  const late = deferred<boolean>();
  const harness = await factoryHarness(t, async () => true);
  const controller = new AbortController();
  const handler = harness.registrations.find((registration) => registration.eventName === "tool_call")!.callback;
  const pending = handler(
    { type: "tool_call", toolName: "bash", toolCallId: "pending-confirm", input: { command: "danger now" } },
    { ...harness.ctx, signal: controller.signal, ui: { ...harness.ctx.ui, confirm: () => late.promise } },
  ) as Promise<{ block?: boolean } | undefined>;
  await settle();
  controller.abort();
  assert.equal((await pending)?.block, true);
  late.resolve(true);
  await settle();
  const rows = historyRowsOf(harness.cwd);
  assert.equal(rows.length, 1);
  assert.deepEqual(historyFields(rows[0]!), { tool: "bash", command: "danger now", decision: "blocked" });
});
