import assert from "node:assert/strict";
import fs from "node:fs";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AssistantMessage, AssistantMessageEventStream, Context, CredentialStore } from "@earendil-works/pi-ai";
import { discoverAndLoadExtensions, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { DEFAULT_REVIEW_EVIDENCE, DEFAULT_REVIEWER, projectConfigPath, SEED_CONFIG } from "../src/config.ts";
import { BUDGET_EXCEEDED_ERROR, POLICY_PROMPT } from "../src/review/protocol.ts";
import { createPiReviewer, createReviewerState, type ReviewContext } from "../src/review/session.ts";

type Pair = { readonly provider: string; readonly id: string };
type Decision = "approve" | "revise" | "ask_user";
type Select = { readonly title: string; readonly options: string[]; readonly resolve: (value: string | undefined) => void };
type Confirm = { readonly title: string; readonly message: string; readonly signal?: AbortSignal; readonly resolve: (approved: boolean) => void };
type Call = { readonly provider: string; readonly id: string; readonly model: object; readonly context: Context; readonly signal?: AbortSignal; readonly release?: (decision: Decision) => void };
type Block = { readonly block: true; readonly reason: string } | undefined;

const EXTENSION_PATH = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const FAKE_A: Pair = { provider: "phase6-a", id: "model" };
const FAKE_B: Pair = { provider: "phase6-b", id: "model" };
const SLASH_A: Pair = { provider: "phase6/c", id: "d" };
const SLASH_B: Pair = { provider: "phase6", id: "c/d" };
const NOAUTH: Pair = { provider: "phase6-noauth", id: "model" };
const ACTIVE: Pair = { provider: "phase6-active", id: "model" };
const ACTIVE_NEXT: Pair = { provider: "phase6-active-2", id: "model" };
const USE_ACTIVE_MODEL = "Use active model";
const FIXTURES: readonly Pair[] = [FAKE_A, FAKE_B, SLASH_A, SLASH_B, NOAUTH, ACTIVE, ACTIVE_NEXT];
const PASSTHROUGH = new Set([`${NOAUTH.provider}/${NOAUTH.id}`]);
const key = (pair: Pair) => `${pair.provider}/${pair.id}`;

type GlobalStartup = "written" | "absent" | "parent-file" | "read-only";

async function createHost(startup: GlobalStartup = "written") {
  const configured = new Set(FIXTURES.filter((pair) => pair !== NOAUTH).map((pair) => pair.provider));
  const credentials: CredentialStore = {
    read: async (providerId) => configured.has(providerId) ? { type: "api_key", key: "test-only" } : undefined,
    list: async () => [...configured].map((providerId) => ({ providerId, type: "api_key" as const })),
    modify: async () => { throw new Error("unexpected credential write"); },
    delete: async () => { throw new Error("unexpected credential delete"); },
  };
  const root = mkdtempSync(join(tmpdir(), "phase6-routing-"));
  const home = join(root, "home");
  const globalDir = join(home, ".pi", "pi-auto-approval");
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  if (startup === "parent-file") {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".pi"), "not a directory");
  } else if (startup === "absent") {
    mkdirSync(home, { recursive: true });
  } else {
    mkdirSync(globalDir, { recursive: true });
    if (startup === "written") writeFileSync(join(globalDir, "auto-permissions.json"), JSON.stringify({ permissions: {}, reviewMode: "auto" }));
    if (startup === "read-only") chmodSync(globalDir, 0o555);
  }
  const previousHome = process.env.HOME;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const registry = new ModelRegistry(runtime);
  for (const pair of FIXTURES) {
    registry.registerProvider(pair.provider, {
      baseUrl: "http://127.0.0.1:9/phase6",
      api: "openai-completions",
      models: [{ id: pair.id, name: pair.id, input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
    });
  }
  await runtime.refresh({ allowNetwork: false });
  const originalStream = registry.streamSimple.bind(registry);
  const calls: Call[] = [];
  registry.streamSimple = ((model, context, options) => {
    if (PASSTHROUGH.has(`${model.provider}/${model.id}`)) {
      calls.push({ provider: model.provider, id: model.id, model: { ...model }, context, signal: options?.signal });
      return originalStream(model, context, options);
    }
    let settle: (message: AssistantMessage) => void = () => {};
    const result = new Promise<AssistantMessage>((resolve) => { settle = resolve; });
    calls.push({
      provider: model.provider,
      id: model.id,
      model: { ...model },
      context,
      signal: options?.signal,
      release: (decision) => settle({
        role: "assistant",
        content: [{ type: "text", text: JSON.stringify({ decision, reason: `${decision} for ${model.provider}/${model.id}` }) }],
        stopReason: "stop",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } as unknown as AssistantMessage),
    });
    return { result: () => result } as unknown as AssistantMessageEventStream;
  }) as typeof registry.streamSimple;
  const sessionManager = { getSessionId: () => "phase6-session", buildSessionProjection: () => ({ entries: [] }) };
  const selects: Select[] = [];
  const confirms: Confirm[] = [];
  const messages: string[] = [];
  const extensions: Awaited<ReturnType<typeof discoverAndLoadExtensions>>["extensions"] = [];
  let activePair: Pair = ACTIVE;
  const context = (hasUI = true) => ({
    cwd,
    hasUI,
    mode: "rpc",
    get model() { return registry.find(activePair.provider, activePair.id); },
    modelRegistry: registry,
    sessionManager,
    isProjectTrusted: () => false,
    signal: undefined,
    ui: {
      select: (title: string, options: string[]) => new Promise<string | undefined>((resolve) => { selects.push({ title, options, resolve }); }),
      confirm: (title: string, message: string, opts?: { signal?: AbortSignal }) => new Promise<boolean>((resolve) => { confirms.push({ title, message, signal: opts?.signal, resolve }); }),
      notify: (message: string, type?: string) => { messages.push(`${type ?? "info"}:${message}`); },
      setStatus: () => {},
      setWidget: () => {},
    },
  }) as never;
  const host = {
    cwd, home, agentDir, globalDir, registry, calls, selects, confirms, messages, extensions, context,
    setActive(pair: Pair) { activePair = pair; },
    async setConfigured(pair: Pair, available: boolean) {
      if (available) configured.add(pair.provider);
      else configured.delete(pair.provider);
      await runtime.refresh({ allowNetwork: false });
    },
    async load() {
      const loaded = await discoverAndLoadExtensions([EXTENSION_PATH], cwd, agentDir);
      assert.deepEqual(loaded.errors, []);
      assert.equal(loaded.extensions.length, 1);
      const extension = loaded.extensions[0];
      assert.ok(extension);
      extensions.push(extension);
      return extension;
    },
    async close() {
      for (const extension of extensions) {
        for (const shutdown of extension.handlers.get("session_shutdown") ?? []) await shutdown({ type: "session_shutdown" }, context());
      }
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      try { chmodSync(globalDir, 0o755); } catch { /* directory absent for this startup case */ }
      rmSync(root, { recursive: true, force: true });
    },
  };
  return host;
}

type Host = Awaited<ReturnType<typeof createHost>>;
type Extension = Awaited<ReturnType<Host["load"]>>;

async function waitFor<T>(list: readonly T[], index: number): Promise<T> {
  for (let tick = 0; tick < 50 && list.length <= index; tick++) await Promise.resolve();
  const item = list[index];
  assert.ok(item, `request ${index + 1} was opened`);
  return item;
}

function assertRouted(host: Host, call: Call, pair: Pair): void {
  assert.equal(`${call.provider}/${call.id}`, key(pair));
  const expected = host.registry.find(pair.provider, pair.id);
  assert.ok(expected, `${key(pair)} is still registered`);
  assert.deepEqual(call.model, { ...expected });
}

function labelFor(host: Host, pair: Pair): string {
  const index = host.registry.getAvailable().findIndex((model) => model.provider === pair.provider && model.id === pair.id);
  assert.notEqual(index, -1, `${key(pair)} is registered`);
  return `${index + 1}. ${key(pair)}`;
}

async function chooseReviewer(host: Host, extension: Extension, label: string): Promise<string[]> {
  const start = host.selects.length;
  const command = extension.commands.get("permissions");
  assert.ok(command, "permissions command is registered");
  const pending = command.handler("", host.context(true));
  (await waitFor(host.selects, start)).resolve("Reviewer model");
  const picker = await waitFor(host.selects, start + 1);
  const options = picker.options;
  picker.resolve(label);
  await pending;
  return options;
}

function bash(host: Host, extension: Extension, command: string, hasUI = true): Promise<Block> {
  const handlers = extension.handlers.get("tool_call") ?? [];
  assert.equal(handlers.length, 1);
  const handler = handlers[0];
  assert.ok(handler);
  return handler({ type: "tool_call", toolName: "bash", toolCallId: `call-${host.calls.length}-${command}`, input: { command } }, host.context(hasUI)) as Promise<Block>;
}

function tool(host: Host, extension: Extension, toolName: string, input: unknown, hasUI = true): Promise<Block> {
  const handlers = extension.handlers.get("tool_call") ?? [];
  assert.equal(handlers.length, 1);
  const handler = handlers[0];
  assert.ok(handler);
  return handler({ type: "tool_call", toolName, toolCallId: `call-${host.calls.length}-${toolName}`, input }, host.context(hasUI)) as Promise<Block>;
}

function sessionStart(host: Host, extension: Extension, reason: string): Promise<unknown> {
  const handlers = extension.handlers.get("session_start") ?? [];
  assert.equal(handlers.length, 1);
  const handler = handlers[0];
  assert.ok(handler);
  return Promise.resolve(handler({ type: "session_start", reason }, host.context(true)));
}

function injectPartialSaveFailure() {
  const originalWrite = fs.writeFileSync;
  const state = { armed: false, injected: 0 };
  fs.writeFileSync = ((file: Parameters<typeof originalWrite>[0], data: Parameters<typeof originalWrite>[1], ...args: Parameters<typeof originalWrite>[2][]) => {
    if (state.armed && String(file).includes("auto-permissions.json.")) {
      state.injected++;
      originalWrite(file, String(data).slice(0, 5), ...args);
      throw new Error("partial failure");
    }
    return originalWrite(file, data, ...args);
  }) as typeof fs.writeFileSync;
  syncBuiltinESMExports();
  return { state, restore: () => { fs.writeFileSync = originalWrite; syncBuiltinESMExports(); } };
}

test("real loader registers the permissions command and the four current handlers", async () => {
  const host = await createHost();
  try {
    const extension = await host.load();
    assert.ok(extension.commands.has("permissions"));
    assert.deepEqual([...extension.handlers.keys()].sort(), ["session_shutdown", "session_start", "tool_call", "tool_execution_end"]);
  } finally { await host.close(); }
});

test("reviewer picker lists only real available entries and routes the selected pair to the stream", async () => {
  const host = await createHost();
  try {
    const extension = await host.load();
    const expected = [USE_ACTIVE_MODEL, ...host.registry.getAvailable().map((model, index) => `${index + 1}. ${model.provider}/${model.id}`)];
    const options = await chooseReviewer(host, extension, labelFor(host, FAKE_A));
    assert.deepEqual(options, expected);
    assert.notEqual(labelFor(host, SLASH_A), labelFor(host, SLASH_B));
    assert.ok(host.registry.find(NOAUTH.provider, NOAUTH.id));
    assert.ok(!options.some((label) => label.endsWith(`. ${key(NOAUTH)}`)));
    const decision = bash(host, extension, "ls");
    const call = await waitFor(host.calls, 0);
    assertRouted(host, call, FAKE_A);
    call.release?.("approve");
    assert.equal(await decision, undefined);
  } finally { await host.close(); }
});

test("explicit reviewer selection survives every session_start reason and a fresh load", async () => {
  const host = await createHost();
  try {
    const extension = await host.load();
    await chooseReviewer(host, extension, labelFor(host, FAKE_A));
    for (const reason of ["startup", "reload", "new", "resume", "fork"]) {
      await sessionStart(host, extension, reason);
      const index = host.calls.length;
      const decision = bash(host, extension, "ls");
      const call = await waitFor(host.calls, index);
      assertRouted(host, call, FAKE_A);
      call.release?.("approve");
      assert.equal(await decision, undefined, reason);
    }
    const fresh = await host.load();
    const index = host.calls.length;
    const decision = bash(host, fresh, "ls");
    const call = await waitFor(host.calls, index);
    assertRouted(host, call, FAKE_A);
    call.release?.("approve");
    assert.equal(await decision, undefined);
  } finally { await host.close(); }
});

test("a queued attempt keeps its captured reviewer while a later selection applies to new attempts", async () => {
  const host = await createHost();
  try {
    const extension = await host.load();
    await chooseReviewer(host, extension, labelFor(host, FAKE_A));
    const first = bash(host, extension, "ls");
    const callA1 = await waitFor(host.calls, 0);
    const second = bash(host, extension, "pwd");
    for (let tick = 0; tick < 20; tick++) await Promise.resolve();
    assert.equal(host.calls.length, 1);
    await chooseReviewer(host, extension, labelFor(host, FAKE_B));
    assert.equal(callA1.signal?.aborted, false);
    callA1.release?.("approve");
    assert.equal(await first, undefined);
    const callA2 = await waitFor(host.calls, 1);
    assertRouted(host, callA2, FAKE_A);
    assert.equal(callA2.signal?.aborted, false);
    callA2.release?.("revise");
    assert.equal((await second)?.block, true);
    const third = bash(host, extension, "whoami");
    const callB = await waitFor(host.calls, 2);
    assertRouted(host, callB, FAKE_B);
    callB.release?.("approve");
    assert.equal(await third, undefined);
  } finally { await host.close(); }
});

test("a failed real save keeps the previous persisted reviewer for the next attempt", async () => {
  const host = await createHost();
  const injection = injectPartialSaveFailure();
  try {
    const extension = await host.load();
    await chooseReviewer(host, extension, labelFor(host, FAKE_A));
    const path = join(host.globalDir, "auto-permissions.json");
    const before = readFileSync(path, "utf8");
    injection.state.armed = true;
    await chooseReviewer(host, extension, labelFor(host, FAKE_B));
    injection.state.armed = false;
    assert.equal(injection.state.injected, 1);
    assert.equal(readFileSync(path, "utf8"), before);
    assert.match(host.messages.join("\n"), /previous selection retained/);
    const decision = bash(host, extension, "ls");
    const call = await waitFor(host.calls, 0);
    assertRouted(host, call, FAKE_A);
    call.release?.("approve");
    assert.equal(await decision, undefined);
  } finally {
    injection.restore();
    await host.close();
  }
});

test("a selected model removed from the registry asks the human and never streams another model", async () => {
  const host = await createHost();
  try {
    const extension = await host.load();
    await chooseReviewer(host, extension, labelFor(host, FAKE_B));
    host.registry.unregisterProvider(FAKE_B.provider);
    assert.equal(host.registry.find(FAKE_B.provider, FAKE_B.id), undefined);
    const approved = bash(host, extension, "ls");
    const first = await waitFor(host.confirms, 0);
    assert.match(first.message, /Automatic review failed: review model not found: phase6-b\/model/);
    assert.match(first.message, /\n\nls$/);
    first.resolve(true);
    assert.equal(await approved, undefined);
    const rejected = bash(host, extension, "pwd");
    (await waitFor(host.confirms, 1)).resolve(false);
    assert.equal((await rejected)?.block, true);
    assert.deepEqual(host.calls, []);
  } finally { await host.close(); }
});

test("a selected model losing configured auth reports the real Pi auth error to the human", async () => {
  const host = await createHost();
  try {
    const extension = await host.load();
    await host.setConfigured(NOAUTH, true);
    await chooseReviewer(host, extension, labelFor(host, NOAUTH));
    await host.setConfigured(NOAUTH, false);
    const decision = bash(host, extension, "ls");
    const confirm = await waitFor(host.confirms, 0);
    assert.match(confirm.message, /Automatic review failed: Provider is not configured: phase6-noauth/);
    confirm.resolve(false);
    assert.equal((await decision)?.block, true);
    assert.deepEqual(host.calls.map((call) => key(call)), [key(NOAUTH)]);
    assertRouted(host, host.calls[0] as Call, NOAUTH);
    assert.equal(host.calls[0]?.release, undefined);
  } finally { await host.close(); }
});

test("without UI, a missing or unauthenticated selected reviewer blocks without a dialog or substitute", async () => {
  const host = await createHost();
  try {
    const extension = await host.load();
    await chooseReviewer(host, extension, labelFor(host, FAKE_B));
    host.registry.unregisterProvider(FAKE_B.provider);
    const missing = await bash(host, extension, "ls", false);
    assert.equal(missing?.block, true);
    assert.match(missing?.reason ?? "", /Automatic review failed: review model not found: phase6-b\/model/);
    await host.setConfigured(NOAUTH, true);
    await chooseReviewer(host, extension, labelFor(host, NOAUTH));
    await host.setConfigured(NOAUTH, false);
    const noauth = await bash(host, extension, "pwd", false);
    assert.equal(noauth?.block, true);
    assert.match(noauth?.reason ?? "", /Provider is not configured: phase6-noauth/);
    assert.equal(host.confirms.length, 0);
    assert.deepEqual(host.calls.map((call) => key(call)), [key(NOAUTH)]);
    assertRouted(host, host.calls[0] as Call, NOAUTH);
  } finally { await host.close(); }
});

test("selecting another reviewer while an unauthenticated fallback dialog is open leaves that attempt governed by its dialog", async () => {
  const host = await createHost();
  try {
    const extension = await host.load();
    await host.setConfigured(NOAUTH, true);
    await chooseReviewer(host, extension, labelFor(host, NOAUTH));
    await host.setConfigured(NOAUTH, false);
    const first = bash(host, extension, "ls");
    const confirm = await waitFor(host.confirms, 0);
    await chooseReviewer(host, extension, labelFor(host, FAKE_B));
    assert.equal(confirm.signal?.aborted, false);
    confirm.resolve(true);
    assert.equal(await first, undefined);
    const next = bash(host, extension, "pwd");
    const call = await waitFor(host.calls, 1);
    assertRouted(host, call, FAKE_B);
    call.release?.("approve");
    assert.equal(await next, undefined);
  } finally { await host.close(); }
});

test("Use active model clears the persisted pair and later attempts follow the live conversation model", async () => {
  const host = await createHost();
  try {
    const extension = await host.load();
    await chooseReviewer(host, extension, labelFor(host, FAKE_A));
    const options = await chooseReviewer(host, extension, USE_ACTIVE_MODEL);
    assert.equal(options[0], USE_ACTIVE_MODEL);
    assert.deepEqual(JSON.parse(readFileSync(join(host.globalDir, "auto-permissions.json"), "utf8")), { permissions: {}, reviewMode: "auto" });
    const first = bash(host, extension, "ls");
    const callActive = await waitFor(host.calls, 0);
    assertRouted(host, callActive, ACTIVE);
    callActive.release?.("approve");
    assert.equal(await first, undefined);
    host.setActive(ACTIVE_NEXT);
    const second = bash(host, extension, "pwd");
    const callNext = await waitFor(host.calls, 1);
    assertRouted(host, callNext, ACTIVE_NEXT);
    callNext.release?.("approve");
    assert.equal(await second, undefined);
  } finally { await host.close(); }
});

test("clearing while an explicit review is unresolved leaves it running and later attempts follow the live active model", async () => {
  const host = await createHost();
  try {
    const extension = await host.load();
    await chooseReviewer(host, extension, labelFor(host, FAKE_A));
    const first = bash(host, extension, "ls");
    const callA = await waitFor(host.calls, 0);
    host.setActive(FAKE_B);
    await chooseReviewer(host, extension, USE_ACTIVE_MODEL);
    assert.equal(callA.signal?.aborted, false);
    callA.release?.("approve");
    assert.equal(await first, undefined);
    const second = bash(host, extension, "pwd");
    const callB = await waitFor(host.calls, 1);
    assertRouted(host, callB, FAKE_B);
    host.setActive(ACTIVE_NEXT);
    callB.release?.("approve");
    assert.equal(await second, undefined);
    const third = bash(host, extension, "whoami");
    const callNext = await waitFor(host.calls, 2);
    assertRouted(host, callNext, ACTIVE_NEXT);
    callNext.release?.("approve");
    assert.equal(await third, undefined);
  } finally { await host.close(); }
});

test("session_start while the clear picker is open discards that delayed clear and keeps the prior selection", async () => {
  const host = await createHost();
  try {
    const extension = await host.load();
    await chooseReviewer(host, extension, labelFor(host, FAKE_A));
    const command = extension.commands.get("permissions");
    assert.ok(command, "permissions command is registered");
    const start = host.selects.length;
    const pending = command.handler("", host.context(true));
    (await waitFor(host.selects, start)).resolve("Reviewer model");
    const picker = await waitFor(host.selects, start + 1);
    await sessionStart(host, extension, "reload");
    picker.resolve(USE_ACTIVE_MODEL);
    await pending;
    assert.deepEqual(JSON.parse(readFileSync(join(host.globalDir, "auto-permissions.json"), "utf8")).reviewer, { provider: FAKE_A.provider, model: FAKE_A.id });
    const decision = bash(host, extension, "ls");
    const call = await waitFor(host.calls, 0);
    assertRouted(host, call, FAKE_A);
    call.release?.("approve");
    assert.equal(await decision, undefined);
    await chooseReviewer(host, extension, USE_ACTIVE_MODEL);
    assert.equal(JSON.parse(readFileSync(join(host.globalDir, "auto-permissions.json"), "utf8")).reviewer, undefined);
  } finally { await host.close(); }
});

const reviewerConfig = { ...DEFAULT_REVIEWER, model: { provider: FAKE_A.provider, id: FAKE_A.id } };
const userText = (call: Call): string => (call.context.messages[0] as unknown as { content: { text: string }[] }).content[0]!.text;
const cardOf = (text: string): string => text.split("<LATEST_PROPOSED_ACTION>\n")[1]!.split("\n</LATEST_PROPOSED_ACTION>")[0]!;
const reviewWith = (host: Host, input: { command?: string; tool?: string; arguments?: unknown }) =>
  createPiReviewer(host.context() as unknown as ReviewContext, createReviewerState())({ ...input, reviewer: reviewerConfig, reviewEvidence: DEFAULT_REVIEW_EVIDENCE, signal: undefined });

test("non-Bash review sends exact tool identity and complete arguments to the selected provider", async () => {
  const host = await createHost();
  try {
    const args = { path: "notes.md", content: "y".repeat(5000) };
    const decision = reviewWith(host, { tool: "write", arguments: args });
    const call = await waitFor(host.calls, 0);
    assertRouted(host, call, FAKE_A);
    assert.equal(call.context.systemPrompt, POLICY_PROMPT);
    assert.deepEqual(JSON.parse(cardOf(userText(call))), { tool: "write", arguments: args, cwd: host.cwd, gate: "Unmatched write tool call", group: null });
    call.release?.("approve");
    const result = await decision;
    assert.equal(result.ok && result.verdict.decision, "approve");
  } finally { await host.close(); }
});

test("legacy command-only review reaches the provider with the exact old Bash card bytes", async () => {
  const host = await createHost();
  try {
    const command = "git push origin main";
    const decision = reviewWith(host, { command });
    const call = await waitFor(host.calls, 0);
    assertRouted(host, call, FAKE_A);
    const text = userText(call);
    assert.equal(cardOf(text), JSON.stringify({ tool: "bash", command, cwd: host.cwd, gate: "Unmatched Bash command", group: null }, null, 2));
    assert.equal(text.includes("undefined"), false);
    call.release?.("approve");
    await decision;
  } finally { await host.close(); }
});

test("oversize non-Bash arguments fail the budget and never reach the provider or approve", async () => {
  const host = await createHost();
  try {
    const result = await reviewWith(host, { tool: "write", arguments: { path: "big.md", content: "x".repeat(200_000) } });
    assert.deepEqual(result, { ok: false, error: BUDGET_EXCEEDED_ERROR });
    assert.equal(host.calls.length, 0);
  } finally { await host.close(); }
});

test("non-serializable non-Bash arguments fail closed without reaching the provider", async () => {
  const host = await createHost();
  try {
    const result = await reviewWith(host, { tool: "custom", arguments: { run() {} } });
    assert.deepEqual(result, { ok: false, error: "review request arguments must be JSON-serializable" });
    assert.equal(host.calls.length, 0);
  } finally { await host.close(); }
});

test("real loader sends an unmatched Write through the registered handler with full arguments and identity", async () => {
  const host = await createHost();
  try {
    const extension = await host.load();
    const args = { path: "notes.md", content: "y".repeat(5000) };
    const decision = tool(host, extension, "write", args);
    const call = await waitFor(host.calls, 0);
    assertRouted(host, call, ACTIVE);
    assert.equal(call.context.systemPrompt, POLICY_PROMPT);
    assert.deepEqual(JSON.parse(cardOf(userText(call))), { tool: "write", arguments: args, cwd: host.cwd, gate: "Unmatched write tool call", group: null });
    call.release?.("approve");
    assert.equal(await decision, undefined);
  } finally { await host.close(); }
});

test("real loader blocks Read .env and Edit/Write secrets before any reviewer request", async () => {
  const host = await createHost();
  try {
    writeFileSync(join(host.globalDir, "auto-permissions.json"), JSON.stringify({ reviewMode: "auto", permissions: { deny: ["Read(./.env)", "Edit(./.env)", "Edit(./secrets/**)"] } }));
    const extension = await host.load();
    assert.match((await tool(host, extension, "read", { path: ".env" }))!.reason, /^Blocked by auto-approval \(Read\(\.\/\.env\), /);
    assert.match((await tool(host, extension, "edit", { path: "./.env", edits: [] }))!.reason, /^Blocked by auto-approval \(Edit\(\.\/\.env\), /);
    assert.match((await tool(host, extension, "write", { path: "secrets/key.pem", content: "x" }))!.reason, /^Blocked by auto-approval \(Edit\(\.\/secrets\/\*\*\), /);
    assert.equal(host.calls.length, 0);
    assert.equal(host.confirms.length, 0);
  } finally { await host.close(); }
});

test("real loader: exact git status needs no provider, git status --short reaches the reviewer, compound rm asks", async () => {
  const host = await createHost();
  try {
    writeFileSync(join(host.globalDir, "auto-permissions.json"), JSON.stringify({ reviewMode: "auto", permissions: { allow: ["Bash(git status)"], ask: ["Bash(rm *)"] } }));
    const extension = await host.load();
    assert.equal(await bash(host, extension, "git status"), undefined);
    assert.equal(host.calls.length, 0);
    assert.equal(host.confirms.length, 0);
    const prefixed = bash(host, extension, "git status --short");
    const review = await waitFor(host.calls, 0);
    assert.match(cardOf(userText(review)), /"command": "git status --short"/);
    review.release?.("approve");
    assert.equal(await prefixed, undefined);
    const compound = bash(host, extension, "git status; rm file");
    const prompt = await waitFor(host.confirms, 0);
    assert.match(prompt.message, /Requires confirmation \(Bash\(rm \*\), /);
    prompt.resolve(false);
    assert.match((await compound)!.reason, /^Requires confirmation \(Bash\(rm \*\), .+\) \(user declined\)$/);
    assert.equal(host.calls.length, 1);
  } finally { await host.close(); }
});

test("real loader: invalid config blocks a non-Bash tool with the run-tools message and no review", async () => {
  const host = await createHost();
  try {
    writeFileSync(join(host.globalDir, "auto-permissions.json"), JSON.stringify({ reviewMode: "auto", rules: [] }));
    const extension = await host.load();
    assert.match((await tool(host, extension, "read", { path: "notes.md" }))!.reason, /^auto-approval: invalid config - .+\. Fix it to run tools\.$/);
    assert.equal(host.calls.length, 0);
    assert.equal(host.confirms.length, 0);
  } finally { await host.close(); }
});

const SEED_BYTES = JSON.stringify(SEED_CONFIG, null, 2) + "\n";
const SEED_WARNING = "warning:Could not create default config ";
const OLD_MTIME = new Date("2001-02-03T04:05:06Z");
const INVALID_CONFIG = /^auto-approval: invalid config - .+\. Fix it to run tools\.$/;

test("real factory load writes nothing; session_start seeds before footer refresh; second startup keeps bytes and mtime", async () => {
  const host = await createHost("absent");
  try {
    const extension = await host.load();
    const path = join(host.globalDir, "auto-permissions.json");
    assert.deepEqual(readdirSync(host.home), []);
    const footerSeen: boolean[] = [];
    const ctx = host.context(true) as unknown as { ui: { setStatus: (key: string, value: unknown) => void } };
    ctx.ui.setStatus = () => { footerSeen.push(fs.existsSync(path)); };
    const startup = extension.handlers.get("session_start")![0]!;
    await startup({ type: "session_start", reason: "startup" }, ctx as never);
    assert.ok(footerSeen.length > 0);
    assert.ok(footerSeen.every(Boolean), "the seed exists at every footer refresh");
    assert.equal(readFileSync(path, "utf8"), SEED_BYTES);
    assert.equal(fs.existsSync(projectConfigPath(host.cwd)), false);
    assert.deepEqual(host.messages.filter((message) => message.startsWith("warning:")), []);
    fs.utimesSync(path, OLD_MTIME, OLD_MTIME);
    await startup({ type: "session_start", reason: "startup" }, ctx as never);
    assert.equal(readFileSync(path, "utf8"), SEED_BYTES);
    assert.equal(fs.statSync(path).mtimeMs, OLD_MTIME.getTime());
    const rm = bash(host, extension, "rm file.txt");
    (await waitFor(host.confirms, 0)).resolve(false);
    assert.match((await rm)!.reason, /^Requires confirmation \(Bash\(rm \*\), .+\) \(user declined\)$/);
    assert.match((await tool(host, extension, "read", { path: ".env" }))!.reason, /^Blocked by auto-approval \(Read\(\.\/\.env\), /);
    assert.match((await tool(host, extension, "edit", { path: "secrets/key.txt", edits: [] }))!.reason, /^Blocked by auto-approval \(Edit\(\.\/secrets\/\*\*\), /);
    assert.match((await tool(host, extension, "write", { path: ".env", content: "x" }))!.reason, /^Blocked by auto-approval \(Edit\(\.\/\.env\), /);
    assert.equal(await bash(host, extension, "git status"), undefined);
    assert.equal(host.calls.length, 0);
    assert.equal(host.confirms.length, 1);
  } finally { await host.close(); }
});

test("real startup seed failure with a file parent warns, keeps handlers, and blocks protected calls without provider or confirmation", async () => {
  const host = await createHost("parent-file");
  try {
    const extension = await host.load();
    assert.deepEqual([...extension.handlers.keys()].sort(), ["session_shutdown", "session_start", "tool_call", "tool_execution_end"]);
    await sessionStart(host, extension, "startup");
    const warnings = host.messages.filter((message) => message.startsWith(SEED_WARNING));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /auto-permissions\.json: ENOTDIR/);
    assert.match((await bash(host, extension, "rm file.txt"))!.reason, INVALID_CONFIG);
    assert.match((await tool(host, extension, "read", { path: ".env" }))!.reason, INVALID_CONFIG);
    assert.equal(host.calls.length, 0);
    assert.equal(host.confirms.length, 0);
  } finally { await host.close(); }
});

test("readable missing global policy keeps the in-memory seed when the seed write fails", async () => {
  const host = await createHost("read-only");
  try {
    const extension = await host.load();
    await sessionStart(host, extension, "startup");
    assert.equal(fs.existsSync(join(host.globalDir, "auto-permissions.json")), false);
    assert.equal(host.messages.filter((message) => message.startsWith(SEED_WARNING)).length, 1);
    const rm = bash(host, extension, "rm file.txt");
    (await waitFor(host.confirms, 0)).resolve(false);
    assert.match((await rm)!.reason, /^Requires confirmation \(Bash\(rm \*\), .+\) \(user declined\)$/);
    assert.match((await tool(host, extension, "edit", { path: "secrets/key.txt", edits: [] }))!.reason, /^Blocked by auto-approval \(Edit\(\.\/secrets\/\*\*\), /);
    assert.equal(await bash(host, extension, "git status"), undefined);
    assert.equal(host.calls.length, 0);
    assert.equal(host.confirms.length, 1);
  } finally { await host.close(); }
});

test("existing invalid or legacy global policy is never repaired and still blocks; explicit opt-out still bypasses", async () => {
  for (const bytes of ["{broken", JSON.stringify({ rules: [{ tool: "bash", pattern: "^rm ", level: "ask" }] })]) {
    const host = await createHost();
    try {
      const extension = await host.load();
      const path = join(host.globalDir, "auto-permissions.json");
      writeFileSync(path, bytes);
      fs.utimesSync(path, OLD_MTIME, OLD_MTIME);
      await sessionStart(host, extension, "startup");
      assert.equal(readFileSync(path, "utf8"), bytes);
      assert.equal(fs.statSync(path).mtimeMs, OLD_MTIME.getTime());
      assert.match((await bash(host, extension, "rm file.txt"))!.reason, INVALID_CONFIG);
      assert.equal(host.calls.length, 0);
      assert.equal(host.confirms.length, 0);
      assert.equal(host.messages.filter((message) => message.startsWith(SEED_WARNING)).length, 0);
    } finally { await host.close(); }
  }
  const host = await createHost();
  try {
    const extension = await host.load();
    const path = join(host.globalDir, "auto-permissions.json");
    const optOut = JSON.stringify({ enabled: false, permissions: { deny: ["Bash(rm *)"] } });
    writeFileSync(path, optOut);
    await sessionStart(host, extension, "startup");
    assert.equal(readFileSync(path, "utf8"), optOut);
    assert.equal(await bash(host, extension, "rm file.txt"), undefined);
    assert.equal(host.calls.length, 0);
    assert.equal(host.confirms.length, 0);
  } finally { await host.close(); }
});

const HISTORY_KEYS = ["command", "decision", "time", "tool"];
const historyPathOf = (cwd: string) => join(cwd, ".pi", "pi-auto-approval", "history.jsonl");
const historyRowsIn = (cwd: string): Array<Record<string, unknown>> => readFileSync(historyPathOf(cwd), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
const afterTick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("real confirmed bash persists four redacted keys only, never the raw token or reasons", async () => {
  const host = await createHost();
  try {
    writeFileSync(join(host.globalDir, "auto-permissions.json"), JSON.stringify({ reviewMode: "manual", permissions: { ask: ["Bash(echo *)"] } }));
    const extension = await host.load();
    const pending = bash(host, extension, "echo token=abc123 && git status");
    (await waitFor(host.confirms, 0)).resolve(true);
    assert.equal(await pending, undefined);
    const rows = historyRowsIn(host.cwd);
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.deepEqual(Object.keys(row).sort(), HISTORY_KEYS);
    assert.equal(row.tool, "bash");
    assert.equal(row.decision, "approved");
    assert.match(String(row.command), /REDACTED/);
    assert.doesNotMatch(String(row.command), /abc123/);
    const raw = readFileSync(historyPathOf(host.cwd), "utf8");
    assert.doesNotMatch(raw, /abc123|Requires confirmation|user declined/);
  } finally { await host.close(); }
});

test("real Read, Edit, Write, and powershell persist path or command only, with no file body", async () => {
  const host = await createHost();
  try {
    writeFileSync(join(host.globalDir, "auto-permissions.json"), JSON.stringify({ reviewMode: "auto", permissions: {} }));
    const extension = await host.load();
    const inputs: Array<[string, unknown]> = [
      ["read", { path: "notes.txt" }],
      ["edit", { path: "src/a.ts", edits: [{ oldText: "SECRET-BODY", newText: "x" }] }],
      ["write", { path: "out.txt", content: "SECRET-BODY" }],
      ["powershell", { command: "Write-Output hello" }],
    ];
    for (const [index, [toolName, input]] of inputs.entries()) {
      const pending = tool(host, extension, toolName, input);
      (await waitFor(host.calls, index)).release?.("approve");
      assert.equal(await pending, undefined);
    }
    assert.deepEqual(historyRowsIn(host.cwd).map((row) => ({ tool: row.tool, command: row.command, decision: row.decision })), [
      { tool: "read", command: "notes.txt", decision: "approved" },
      { tool: "edit", command: "src/a.ts", decision: "approved" },
      { tool: "write", command: "out.txt", decision: "approved" },
      { tool: "powershell", command: "Write-Output hello", decision: "approved" },
    ]);
    assert.doesNotMatch(readFileSync(historyPathOf(host.cwd), "utf8"), /SECRET-BODY/);
  } finally { await host.close(); }
});

test("real history save failure keeps approve and deny outcomes and warns exactly once", async () => {
  const host = await createHost();
  try {
    writeFileSync(join(host.globalDir, "auto-permissions.json"), JSON.stringify({ reviewMode: "auto", permissions: { deny: ["Bash(rm *)"] } }));
    const extension = await host.load();
    mkdirSync(historyPathOf(host.cwd), { recursive: true });
    const approved = bash(host, extension, "ls");
    (await waitFor(host.calls, 0)).release?.("approve");
    assert.equal(await approved, undefined);
    assert.match((await bash(host, extension, "rm file.txt"))!.reason, /^Blocked by auto-approval \(Bash\(rm \*\), /);
    const warnings = host.messages.filter((message) => message.startsWith("warning:") && message.includes("auto-approval history"));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /History save failed/);
  } finally { await host.close(); }
});

test("real protection off writes no history file", async () => {
  const host = await createHost();
  try {
    writeFileSync(join(host.globalDir, "auto-permissions.json"), JSON.stringify({ enabled: false, reviewMode: "auto", permissions: { deny: ["Bash(rm *)"] } }));
    const extension = await host.load();
    assert.equal(await bash(host, extension, "rm file.txt"), undefined);
    assert.equal(existsSync(historyPathOf(host.cwd)), false);
  } finally { await host.close(); }
});

test("real outer abort with pending confirmation records one blocked row and ignores late approval", async () => {
  const host = await createHost();
  try {
    writeFileSync(join(host.globalDir, "auto-permissions.json"), JSON.stringify({ reviewMode: "manual", permissions: { ask: ["Bash(echo *)"] } }));
    const extension = await host.load();
    const controller = new AbortController();
    const handler = (extension.handlers.get("tool_call") ?? [])[0]!;
    const pending = handler({ type: "tool_call", toolName: "bash", toolCallId: "abort-confirm", input: { command: "echo token=abc123" } }, { ...(host.context(true) as object), signal: controller.signal }) as Promise<Block>;
    const prompt = await waitFor(host.confirms, 0);
    controller.abort();
    assert.equal((await pending)?.block, true);
    prompt.resolve(true);
    await afterTick();
    const rows = historyRowsIn(host.cwd);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.decision, "blocked");
  } finally { await host.close(); }
});

test("real outer abort with pending review records one blocked row and ignores late approval", async () => {
  const host = await createHost();
  try {
    writeFileSync(join(host.globalDir, "auto-permissions.json"), JSON.stringify({ reviewMode: "auto", permissions: {} }));
    const extension = await host.load();
    const controller = new AbortController();
    const handler = (extension.handlers.get("tool_call") ?? [])[0]!;
    const pending = handler({ type: "tool_call", toolName: "bash", toolCallId: "abort-review", input: { command: "ls" } }, { ...(host.context(true) as object), signal: controller.signal }) as Promise<Block>;
    const review = await waitFor(host.calls, 0);
    controller.abort();
    assert.equal((await pending)?.block, true);
    review.release?.("approve");
    await afterTick();
    const rows = historyRowsIn(host.cwd);
    assert.equal(rows.length, 1);
    assert.deepEqual({ tool: rows[0]!.tool, command: rows[0]!.command, decision: rows[0]!.decision }, { tool: "bash", command: "ls", decision: "blocked" });
  } finally { await host.close(); }
});

function abortAfterMicrotasks(controller: AbortController, hops: number): () => void {
  const hop = (remaining: number): void => { if (remaining === 0) controller.abort(); else queueMicrotask(() => hop(remaining - 1)); };
  return () => hop(hops);
}
function contextWithStatus(host: Host, signal: AbortSignal | undefined, setStatus: () => void): object {
  const base = host.context(true) as { ui: object };
  return { ...base, signal, ui: { ...base.ui, setStatus } };
}

test("real off with an already-aborted signal blocks without writing history", async () => {
  const host = await createHost();
  try {
    writeFileSync(join(host.globalDir, "auto-permissions.json"), JSON.stringify({ enabled: false, reviewMode: "auto", permissions: { deny: ["Bash(rm *)"] } }));
    const extension = await host.load();
    const controller = new AbortController();
    controller.abort();
    const handler = (extension.handlers.get("tool_call") ?? [])[0]!;
    const result = await handler({ type: "tool_call", toolName: "bash", toolCallId: "off-aborted", input: { command: "rm file.txt" } }, { ...(host.context(true) as object), signal: controller.signal }) as Block;
    assert.equal(result?.block, true);
    assert.equal(existsSync(historyPathOf(host.cwd)), false);
  } finally { await host.close(); }
});

const OFF_LATE_OUTCOMES = [
  { hops: 1, reason: "auto-approval: confirmation failed" },
  { hops: 2, reason: undefined },
] as const;
for (const { hops, reason } of OFF_LATE_OUTCOMES) {
  test(`real off with a ${hops}-microtask abort keeps the race outcome and writes no history`, async () => {
    const host = await createHost();
    try {
      writeFileSync(join(host.globalDir, "auto-permissions.json"), JSON.stringify({ enabled: false, reviewMode: "auto", permissions: { deny: ["Bash(rm *)"] } }));
      const extension = await host.load();
      const controller = new AbortController();
      const handler = (extension.handlers.get("tool_call") ?? [])[0]!;
      const pending = handler({ type: "tool_call", toolName: "bash", toolCallId: `off-late-${hops}`, input: { command: "rm file.txt" } }, contextWithStatus(host, controller.signal, abortAfterMicrotasks(controller, hops))) as Promise<Block>;
      assert.equal((await pending)?.reason, reason);
      assert.equal(existsSync(historyPathOf(host.cwd)), false);
    } finally { await host.close(); }
  });

  test(`real enabled allow with a ${hops}-microtask abort records exactly one row matching the returned winner`, async () => {
    const host = await createHost();
    try {
      writeFileSync(join(host.globalDir, "auto-permissions.json"), JSON.stringify({ enabled: true, reviewMode: "manual", permissions: { allow: ["Bash(echo *)"] } }));
      const extension = await host.load();
      const controller = new AbortController();
      const handler = (extension.handlers.get("tool_call") ?? [])[0]!;
      const pending = handler({ type: "tool_call", toolName: "bash", toolCallId: `on-late-${hops}`, input: { command: "echo ok" } }, contextWithStatus(host, controller.signal, abortAfterMicrotasks(controller, hops))) as Promise<Block>;
      const result = await pending;
      const rows = historyRowsIn(host.cwd);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.decision, result?.block ? "blocked" : "approved");
      assert.equal(rows[0]!.command, "echo ok");
    } finally { await host.close(); }
  });
}

test("real enabled already-aborted call records exactly one blocked row", async () => {
  const host = await createHost();
  try {
    writeFileSync(join(host.globalDir, "auto-permissions.json"), JSON.stringify({ enabled: true, reviewMode: "manual", permissions: { allow: ["Bash(echo *)"] } }));
    const extension = await host.load();
    const controller = new AbortController();
    controller.abort();
    const handler = (extension.handlers.get("tool_call") ?? [])[0]!;
    const result = await handler({ type: "tool_call", toolName: "bash", toolCallId: "on-aborted", input: { command: "echo ok" } }, { ...(host.context(true) as object), signal: controller.signal }) as Block;
    assert.equal(result?.block, true);
    const rows = historyRowsIn(host.cwd);
    assert.equal(rows.length, 1);
    assert.deepEqual({ tool: rows[0]!.tool, command: rows[0]!.command, decision: rows[0]!.decision }, { tool: "bash", command: "echo ok", decision: "blocked" });
  } finally { await host.close(); }
});
