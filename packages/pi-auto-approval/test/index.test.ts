import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { afterEach, mock } from "node:test";
import { parseConfig } from "../src/config.ts";
import { matchRule } from "../src/gates.ts";
import { createWidgetReporter, handleToolCall } from "../src/index.ts";
import type { ConfigLoader, GateContext } from "../src/index.ts";
import type { ConfigResult, Rule } from "../src/config.ts";

afterEach(() => mock.timers.reset());
import type { ExtensionAPI, ExtensionHandler, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
type ToolCallHandler = ExtensionHandler<ToolCallEvent, ToolCallEventResult>;

const rule = (level: "guarded" | "convention" = "guarded", group?: string): Rule => ({
  pattern: /danger/i,
  level,
  label: "danger command",
  ...(group === undefined ? {} : { group }),
  ...(level === "convention" ? { message: "Use the approved workflow." } : { message: undefined }),
});
const ruleSet = (level: "guarded" | "convention" = "guarded"): Rule[] => [rule(level)];
const config = (rules = ruleSet()): ConfigResult => ({ ok: true, rules, source: "mock", ui: { status: true } });
const loadConfig: ConfigLoader = () => config();
function context(overrides: Partial<GateContext> = {}) {
  const calls: unknown[][] = [];
  const ctx: GateContext = {
    cwd: "/tmp",
    hasUI: true,
    signal: undefined,
    ui: { confirm: async (...args) => { calls.push(args); return true; } },
    ...overrides,
  };
  return { ctx, calls };
}
const event = (command: unknown = "dangerous") => ({ toolName: "bash", input: { command } });

test("non-bash does not load config; unmatched bash runs", async () => {
  let loads = 0;
  const statuses: string[] = [];
  const { ctx, calls } = context();
  assert.equal(await handleToolCall({ toolName: "other", input: {} }, ctx, () => { loads++; return config(); }, { status: (state) => statuses.push(state) }), undefined);
  assert.equal(await handleToolCall(event("echo ok"), ctx, () => { loads++; return config(); }, { status: (state) => statuses.push(state) }), undefined);
  assert.equal(loads, 1);
  assert.equal(calls.length, 0);
  assert.equal(statuses.length, 0);
});

test("invalid bash input and config failures block", async () => {
  const { ctx, calls } = context();
  assert.equal((await handleToolCall(event(null), ctx, loadConfig))?.reason, "auto-approval: invalid bash input");
  assert.match((await handleToolCall(event(), ctx, () => ({ ok: false, error: "bad file" })) )!.reason, /invalid config - bad file/);
  assert.equal((await handleToolCall(event(), ctx, () => { throw Error(); }))?.reason, "auto-approval: config load failed");
  assert.equal(calls.length, 0);
});

test("convention blocks with configured message", async () => {
  const { ctx, calls } = context();
  assert.equal((await handleToolCall(event(), ctx, () => config(ruleSet("convention"))))?.reason, "Use the approved workflow.");
  assert.equal(calls.length, 0);
});

test("guarded command confirms exact raw command and label", async () => {
  const { ctx, calls } = context();
  assert.equal(await handleToolCall(event("danger; echo hi"), ctx, loadConfig), undefined);
  assert.deepEqual(calls[0]?.slice(0, 2), ["Approve command? [danger command]", "danger; echo hi"]);
});

test("no UI blocks guarded command", async () => {
  const statuses: string[] = [];
  const noUi = context({ hasUI: false });
  assert.match((await handleToolCall(event(), noUi.ctx, loadConfig, { status: (state) => statuses.push(state) }))!.reason, /no UI to confirm/);
  assert.equal(noUi.calls.length, 0);
  assert.equal(statuses.length, 0);
});

test("trusted guarded rule bypasses confirmation and reports status", async () => {
  const statuses: string[] = [];
  const { ctx, calls } = context();
  assert.equal(await handleToolCall(event(), ctx, () => config([rule("guarded", "git")]), {
    trusted: () => new Set(["git"]), status: (state) => statuses.push(state),
  }), undefined);
  assert.equal(calls.length, 0);
  assert.deepEqual(statuses, ["approved"]);
});

test("trusted guarded rule allows without UI and reports no status", async () => {
  const statuses: string[] = [];
  const noUi = context({ hasUI: false });
  assert.equal(await handleToolCall(event(), noUi.ctx, () => config([rule("guarded", "git")]), {
    trusted: () => new Set(["git"]), status: (state) => statuses.push(state),
  }), undefined);
  assert.equal(noUi.calls.length, 0);
  assert.equal(statuses.length, 0);
});

test("trusted loader abort after returning blocks unmatched command", async () => {
  const controller = new AbortController();
  const statuses: string[] = [];
  const { ctx, calls } = context({ signal: controller.signal });
  const result = await handleToolCall(event("echo ok"), ctx, loadConfig, {
    trusted: () => { controller.abort(); return new Set(["git"]); }, status: (state) => statuses.push(state),
  });
  assert.match(result!.reason, /confirmation failed/);
  assert.equal(calls.length, 0);
  assert.equal(statuses.length, 0);
});

test("trusted guarded rule blocks when aborted during trust membership", async () => {
  const controller = new AbortController();
  const trusted = new Set<string>();
  Object.defineProperty(trusted, "has", { value: () => { controller.abort(); return true; } });
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
    trusted: () => new Set(["git"]), status: () => { controller.abort(); },
  });
  assert.match(result!.reason, /confirmation failed/);
  assert.equal(calls.length, 0);
});

test("untrusted guarded rule confirms; convention cannot bypass", async () => {
  const statuses: string[] = [];
  const { ctx, calls } = context();
  assert.equal(await handleToolCall(event(), ctx, () => config([rule("guarded", "git")]), {
    trusted: () => new Set(["other"]), status: (state) => statuses.push(state),
  }), undefined);
  assert.equal(calls.length, 1);
  const blocked = await handleToolCall(event(), ctx, () => config([rule("convention", "git")]), {
    trusted: () => new Set(["git"]), status: (state) => statuses.push(state),
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
  assert.equal(await handleToolCall(event(), trusted.ctx, () => hiddenConfig([rule("guarded", "git")]), {
    trusted: () => new Set(["git"]), status: (state) => statuses.push(state),
  }), undefined);
  assert.equal(trusted.calls.length, 0);
  assert.equal(statuses.length, 0);

  const convention = await handleToolCall(event(), trusted.ctx, () => hiddenConfig(ruleSet("convention")), {
    trusted: () => new Set(["git"]), status: (state) => statuses.push(state),
  });
  assert.equal(convention?.reason, "Use the approved workflow.");
  assert.equal(statuses.length, 0);
});

test("trust loader and membership failures fall back to confirmation", async () => {
  const { ctx, calls } = context();
  const trusted = new Set<string>();
  Object.defineProperty(trusted, "has", { value: () => { throw Error("membership failed"); } });
  assert.equal(await handleToolCall(event(), ctx, () => config([rule("guarded", "git")]), {
    trusted: () => { throw Error("loader failed"); },
  }), undefined);
  assert.equal(calls.length, 1);
  assert.equal(await handleToolCall(event(), ctx, () => config([rule("guarded", "git")]), {
    trusted: () => trusted,
  }), undefined);
  assert.equal(calls.length, 2);
});

test("status reporter failures do not change allow or block decisions", async () => {
  const throwing = () => { throw Error("widget failed"); };
  assert.equal(await handleToolCall(event(), context().ctx, loadConfig, { status: throwing }), undefined);
  const denied = context({ ui: { confirm: async () => false } });
  assert.match((await handleToolCall(event(), denied.ctx, loadConfig, { status: throwing }))!.reason, /user declined/);
  assert.equal((await handleToolCall(event(), context().ctx, () => config(ruleSet("convention")), { status: throwing }))?.reason, "Use the approved workflow.");
});

test("user denial blocks", async () => {
  const statuses: string[] = [];
  const denied = context({ ui: { confirm: async () => false } });
  assert.match((await handleToolCall(event(), denied.ctx, loadConfig, { status: (state) => statuses.push(state) }))!.reason, /user declined/);
  assert.deepEqual(statuses, ["reviewing", "blocked"]);
});

test("confirmation throwing blocks", async () => {
  const statuses: string[] = [];
  const failed = context({ ui: { confirm: async () => { throw Error(); } } });
  assert.match((await handleToolCall(event(), failed.ctx, loadConfig, { status: (state) => statuses.push(state) }))!.reason, /confirmation failed/);
  assert.deepEqual(statuses, ["reviewing", "blocked"]);
});

test("already-aborted signal blocks without prompting", async () => {
  const statuses: string[] = [];
  const controller = new AbortController(); controller.abort();
  const aborted = context({ signal: controller.signal });
  assert.equal((await handleToolCall(event(), aborted.ctx, loadConfig, { status: (state) => statuses.push(state) }))?.reason, "auto-approval: confirmation failed");
  assert.equal(aborted.calls.length, 0);
  assert.equal(statuses.length, 0);
});

test("matcher errors block", async () => {
  assert.equal((await handleToolCall(event(), context().ctx, loadConfig, { matcher: () => { throw Error(); } }))?.reason, "auto-approval: matcher error");
});

test("abort during confirmation blocks even when confirmation approves", async () => {
  const statuses: string[] = [];
  const controller = new AbortController();
  const during = context({ signal: controller.signal, ui: { confirm: async () => { controller.abort(); return true; } } });
  assert.match((await handleToolCall(event(), during.ctx, loadConfig, { status: (state) => statuses.push(state) }))!.reason, /confirmation failed/);
  assert.deepEqual(statuses, ["reviewing", "blocked"]);
});

test("abort during approved status reporting blocks confirmed command", async () => {
  const statuses: string[] = [];
  const controller = new AbortController();
  const { ctx, calls } = context({ signal: controller.signal });
  const result = await handleToolCall(event(), ctx, loadConfig, {
    status: (state) => { statuses.push(state); if (state === "approved") controller.abort(); },
  });
  assert.match(result!.reason, /confirmation failed/);
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
  assert.deepEqual(setWidget.mock.calls.map((call) => call.arguments), [["auto-approval:one", ["auto-approval: reviewing [review]"]]]);
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
  assert.deepEqual(setWidget.mock.calls.map((call) => call.arguments), [
    ["auto-approval:one", ["auto-approval: approved [old]"]],
    ["auto-approval:two", ["auto-approval: reviewing [new]"]],
    ["auto-approval:one", undefined],
  ]);
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
  const report = createWidgetReporter({ setWidget: () => { calls++; throw Error("widget failed"); } }, "auto-approval:one");
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
  const { cwd, invoke } = await factoryHarness(t, async () => { confirmations++; return true; }, { group: "git" });
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
  const { cwd, invoke } = await factoryHarness(t, async () => { confirmations++; return false; }, { group: "git" });
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
    return new Promise<boolean>((resolve) => { finishPrompt = resolve; });
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
    return new Promise<boolean>((_resolve, reject) => { rejectPrompt = reject; });
  });
  const first = invoke();
  rejectPrompt(Error("prompt failed"));
  assert.match((await first as { block: true; reason: string }).reason, /confirmation failed/);
  let freshPrompted = false;
  const next = invoke(async () => { freshPrompted = true; return true; });
  assert.equal(await next, undefined);
  assert.equal(freshPrompted, true);
  assert.equal(confirmations, 1);
});

async function factoryHarness(t: TestContext, confirm: (...args: unknown[]) => Promise<boolean>, { group, uiStatus = true }: { group?: string; uiStatus?: boolean } = {}) {
  const { default: autoApproval } = await import("../src/index.ts");
  const registrations: Array<{ eventName: "tool_call"; callback: ToolCallHandler }> = [];
  const pi = { on: ((eventName: "tool_call", callback: ToolCallHandler) => { registrations.push({ eventName, callback }); return () => {}; }) as ExtensionAPI["on"] } as ExtensionAPI;
  autoApproval(pi);
  const cwd = mkdtempSync(join(tmpdir(), "auto-approval-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(cwd, ".pi", "auto-permissions.json"), JSON.stringify({ rules: [{ pattern: "danger", level: "guarded", label: "danger", ...(group === undefined ? {} : { group }) }], ui: { status: uiStatus } }));
  const setWidget = mock.fn((_key: string, _content: string[] | undefined) => {});
  const invoke = (confirmPrompt = confirm) => {
    const ctx = { cwd, hasUI: true, signal: undefined, ui: { confirm: confirmPrompt, setWidget } } as unknown as Parameters<ToolCallHandler>[1];
    return registrations[0]!.callback(event() as ToolCallEvent, ctx);
  };
  return { cwd, registrations, setWidget, invoke };
}

test("factory widget shows reviewing, then approved or blocked, and clears after 2000 ms", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let finish!: (approved: boolean) => void;
  const approve = await factoryHarness(t, () => new Promise<boolean>((resolve) => { finish = resolve; }));
  const pending = approve.invoke();
  assert.deepEqual(approve.setWidget.mock.calls.map((call) => call.arguments), [["auto-approval:1", ["auto-approval: reviewing [danger]"]]]);
  finish(true);
  assert.equal(await pending, undefined);
  assert.deepEqual(approve.setWidget.mock.calls.at(-1)?.arguments, ["auto-approval:1", ["auto-approval: approved [danger]"]]);
  mock.timers.tick(1999);
  assert.equal(approve.setWidget.mock.calls.length, 2);
  mock.timers.tick(1);
  assert.deepEqual(approve.setWidget.mock.calls.at(-1)?.arguments, ["auto-approval:1", undefined]);

  const deny = await factoryHarness(t, async () => false);
  assert.match((await deny.invoke() as { reason: string }).reason, /user declined/);
  assert.deepEqual(deny.setWidget.mock.calls.map((call) => call.arguments), [
    ["auto-approval:1", ["auto-approval: reviewing [danger]"]],
    ["auto-approval:1", ["auto-approval: blocked [danger]"]],
  ]);
  mock.timers.tick(2000);
  assert.deepEqual(deny.setWidget.mock.calls.at(-1)?.arguments, ["auto-approval:1", undefined]);
});

test("ui.status false suppresses factory widget calls without changing enforcement", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const declinedConfirm = mock.fn(async () => false);
  const declined = await factoryHarness(t, declinedConfirm, { uiStatus: false });
  assert.match((await declined.invoke() as { reason: string }).reason, /user declined/);
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
  for (const command of ["git push origin main", "rm -rf /tmp/x", "rm -fr /tmp/x", "terraform apply"]) assert.ok(matchRule(command, parsed.rules));
  for (const command of ["git status", "rm -r /tmp/x", "terraform plan"]) assert.equal(matchRule(command, parsed.rules), undefined);
});
