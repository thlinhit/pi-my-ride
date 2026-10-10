import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseConfig } from "../src/config.ts";
import { matchRule } from "../src/gates.ts";
import { handleToolCall } from "../src/index.ts";
import type { ConfigLoader, GateContext } from "../src/index.ts";
import type { ConfigResult } from "../src/config.ts";
import type { ExtensionAPI, ExtensionHandler, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
type ToolCallHandler = ExtensionHandler<ToolCallEvent, ToolCallEventResult>;

const rule = (level: "guarded" | "convention" = "guarded") => ({
  pattern: /danger/i,
  level,
  label: "danger command",
  ...(level === "convention" ? { message: "Use the approved workflow." } : { message: undefined }),
});
const ruleSet = (level: "guarded" | "convention" = "guarded") => [Object.assign(rule(level), { pattern: new RegExp("danger", "i") }) as import("../src/config.ts").Rule];
const config = (rules = ruleSet()): ConfigResult => ({ ok: true, rules, source: "mock" });
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
  const { ctx, calls } = context();
  assert.equal(await handleToolCall({ toolName: "other", input: {} }, ctx, () => { loads++; return config(); }), undefined);
  assert.equal(await handleToolCall(event("echo ok"), ctx, () => { loads++; return config(); }), undefined);
  assert.equal(loads, 1);
  assert.equal(calls.length, 0);
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
  const noUi = context({ hasUI: false });
  assert.match((await handleToolCall(event(), noUi.ctx, loadConfig))!.reason, /no UI to confirm/);
  assert.equal(noUi.calls.length, 0);
});

test("user denial blocks", async () => {
  const denied = context({ ui: { confirm: async () => false } });
  assert.match((await handleToolCall(event(), denied.ctx, loadConfig))!.reason, /user declined/);
});

test("confirmation throwing blocks", async () => {
  const failed = context({ ui: { confirm: async () => { throw Error(); } } });
  assert.match((await handleToolCall(event(), failed.ctx, loadConfig))!.reason, /confirmation failed/);
});

test("already-aborted signal blocks without prompting", async () => {
  const controller = new AbortController(); controller.abort();
  const aborted = context({ signal: controller.signal });
  assert.equal((await handleToolCall(event(), aborted.ctx, loadConfig))?.reason, "auto-approval: confirmation failed");
  assert.equal(aborted.calls.length, 0);
});

test("matcher errors block", async () => {
  assert.equal((await handleToolCall(event(), context().ctx, loadConfig, () => { throw Error(); }))?.reason, "auto-approval: matcher error");
});

test("abort during confirmation blocks even when confirmation approves", async () => {
  const controller = new AbortController();
  const during = context({ signal: controller.signal, ui: { confirm: async () => { controller.abort(); return true; } } });
  assert.match((await handleToolCall(event(), during.ctx, loadConfig))!.reason, /confirmation failed/);
});

test("non-boolean confirmation result blocks", async () => {
  const invalid = context({ ui: { confirm: async () => undefined as unknown as boolean } });
  assert.notEqual(await handleToolCall(event(), invalid.ctx, loadConfig), undefined);
});

test("factory registers exactly one tool_call handler", async () => {
  const { default: autoApproval } = await import("../src/index.ts");
  const registrations: Array<{ eventName: "tool_call"; callback: ToolCallHandler }> = [];
  const pi = { on: ((eventName: "tool_call", callback: ToolCallHandler) => { registrations.push({ eventName, callback }); return () => {}; }) as ExtensionAPI["on"] } as ExtensionAPI;
  autoApproval(pi);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0]?.eventName, "tool_call");
  assert.equal(typeof registrations[0]?.callback, "function");
});

test("factory allows only one concurrent confirmation and releases the lock", async () => {
  const { default: autoApproval } = await import("../src/index.ts");
  let callback: ToolCallHandler | undefined;
  const pi = { on: ((eventName: "tool_call", registered: ToolCallHandler) => { callback = registered; return () => {}; }) as ExtensionAPI["on"] } as ExtensionAPI;
  autoApproval(pi);
  const cwd = mkdtempSync(join(tmpdir(), "auto-approval-"));
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(cwd, ".pi", "auto-permissions.json"), JSON.stringify({ rules: [{ pattern: "danger", level: "guarded", label: "danger" }] }));
  let finishPrompt!: (approved: boolean) => void;
  let confirmations = 0;
  const ctx = context({ cwd, ui: { confirm: async () => {
    confirmations++;
    return new Promise<boolean>((resolve) => { finishPrompt = resolve; });
  } } }).ctx;
  const first = callback!(event() as ToolCallEvent, ctx as Parameters<ToolCallHandler>[1]);
  const second = await callback!(event() as ToolCallEvent, ctx as Parameters<ToolCallHandler>[1]);
  assert.match((second as { block: true; reason: string }).reason, /confirmation failed/);
  assert.equal(confirmations, 1);
  finishPrompt(true);
  assert.equal(await first, undefined);
  const third = callback!(event() as ToolCallEvent, { ...ctx, ui: { confirm: async () => true } } as unknown as Parameters<ToolCallHandler>[1]);
  assert.equal(await third, undefined);
});

test("factory releases confirmation lock after a rejecting prompt", async () => {
  const { default: autoApproval } = await import("../src/index.ts");
  let callback: ToolCallHandler | undefined;
  const pi = { on: ((eventName: "tool_call", registered: ToolCallHandler) => { callback = registered; return () => {}; }) as ExtensionAPI["on"] } as ExtensionAPI;
  autoApproval(pi);
  const cwd = mkdtempSync(join(tmpdir(), "auto-approval-"));
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(cwd, ".pi", "auto-permissions.json"), JSON.stringify({ rules: [{ pattern: "danger", level: "guarded", label: "danger" }] }));
  let rejectPrompt!: (error: Error) => void;
  let confirmations = 0;
  const ctx = context({ cwd, ui: { confirm: async () => {
    confirmations++;
    return new Promise<boolean>((_resolve, reject) => { rejectPrompt = reject; });
  } } }).ctx;
  const first = callback!(event() as ToolCallEvent, ctx as Parameters<ToolCallHandler>[1]);
  rejectPrompt(Error("prompt failed"));
  assert.match((await first as { block: true; reason: string }).reason, /confirmation failed/);
  let freshPrompted = false;
  const next = callback!(event() as ToolCallEvent, { ...ctx, ui: { confirm: async () => { freshPrompted = true; return true; } } } as unknown as Parameters<ToolCallHandler>[1]);
  assert.equal(await next, undefined);
  assert.equal(freshPrompted, true);
  assert.equal(confirmations, 1);
});

test("starter rules match intended commands", () => {
  const raw = JSON.parse(readFileSync(new URL("../examples/auto-permissions.json", import.meta.url), "utf8"));
  const parsed = parseConfig(raw, "example");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  for (const command of ["git push origin main", "rm -rf /tmp/x", "rm -fr /tmp/x", "terraform apply"]) assert.ok(matchRule(command, parsed.rules));
  for (const command of ["git status", "rm -r /tmp/x", "terraform plan"]) assert.equal(matchRule(command, parsed.rules), undefined);
});
