import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AssistantMessage, AssistantMessageEventStream, CredentialStore } from "@earendil-works/pi-ai";
import { discoverAndLoadExtensions, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

type Pair = { readonly provider: string; readonly id: string };
type Decision = "approve" | "revise" | "ask_user";
type Select = { readonly title: string; readonly options: string[]; readonly resolve: (value: string | undefined) => void };
type Confirm = { readonly title: string; readonly message: string; readonly signal?: AbortSignal; readonly resolve: (approved: boolean) => void };
type Call = { readonly provider: string; readonly id: string; readonly model: object; readonly signal?: AbortSignal; readonly release?: (decision: Decision) => void };
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

async function createHost() {
  const configured = new Set(FIXTURES.filter((pair) => pair !== NOAUTH).map((pair) => pair.provider));
  const credentials: CredentialStore = {
    read: async (providerId) => configured.has(providerId) ? { type: "api_key", key: "test-only" } : undefined,
    list: async () => [...configured].map((providerId) => ({ providerId, type: "api_key" as const })),
    modify: async () => { throw new Error("unexpected credential write"); },
    delete: async () => { throw new Error("unexpected credential delete"); },
  };
  const root = mkdtempSync(join(tmpdir(), "phase6-routing-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(agentDir, "auto-permissions.json"), JSON.stringify({ rules: [], reviewMode: "auto" }));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
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
      calls.push({ provider: model.provider, id: model.id, model: { ...model }, signal: options?.signal });
      return originalStream(model, context, options);
    }
    let settle: (message: AssistantMessage) => void = () => {};
    const result = new Promise<AssistantMessage>((resolve) => { settle = resolve; });
    calls.push({
      provider: model.provider,
      id: model.id,
      model: { ...model },
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
    cwd, agentDir, registry, calls, selects, confirms, messages, extensions, context,
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
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
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
    const path = join(host.agentDir, "auto-permissions.json");
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
    assert.deepEqual(JSON.parse(readFileSync(join(host.agentDir, "auto-permissions.json"), "utf8")), { rules: [], reviewMode: "auto" });
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
    assert.deepEqual(JSON.parse(readFileSync(join(host.agentDir, "auto-permissions.json"), "utf8")).reviewer, { provider: FAKE_A.provider, model: FAKE_A.id });
    const decision = bash(host, extension, "ls");
    const call = await waitFor(host.calls, 0);
    assertRouted(host, call, FAKE_A);
    call.release?.("approve");
    assert.equal(await decision, undefined);
    await chooseReviewer(host, extension, USE_ACTIVE_MODEL);
    assert.equal(JSON.parse(readFileSync(join(host.agentDir, "auto-permissions.json"), "utf8")).reviewer, undefined);
  } finally { await host.close(); }
});
