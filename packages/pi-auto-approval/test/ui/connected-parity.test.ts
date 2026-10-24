import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createBashToolDefinition,
  createExtensionRuntime,
  ExtensionRunner,
  initTheme,
  ToolExecutionComponent,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolRendererResolver, ToolRenderers } from "@earendil-works/pi-coding-agent";
import autoApproval from "../../src/index.ts";

initTheme("dark", false);

const nativeBash = createBashToolDefinition(process.cwd());
type Scenario = {
  name: string;
  config: Record<string, unknown>;
  command?: string;
  trusted?: boolean;
  confirm?: "yes" | "no" | "error";
  reply?: string;
  expectedBlock?: RegExp;
  expectedStatuses: string[];
  expectedConfirmations: number;
  expectedProviderCalls: number;
};

const scenarios: Scenario[] = [
  { name: "deny", config: { permissions: { deny: ["Bash(danger)"] } }, expectedBlock: /Blocked by auto-approval/, expectedStatuses: ["blocked"], expectedConfirmations: 0, expectedProviderCalls: 0 },
  { name: "ordinary allow", config: { permissions: { allow: ["Bash(danger)"] } }, command: "danger", expectedStatuses: ["approved"], expectedConfirmations: 0, expectedProviderCalls: 0 },
  { name: "suspicious allow", config: { permissions: { allow: ["Bash(danger; echo harmless)"] } }, expectedStatuses: ["approval-required", "approved"], expectedConfirmations: 1, expectedProviderCalls: 0 },
  { name: "manual unmatched approval", config: {}, expectedStatuses: ["approval-required", "approved"], expectedConfirmations: 1, expectedProviderCalls: 0 },
  { name: "manual unmatched denial", config: {}, confirm: "no", expectedBlock: /user declined/, expectedStatuses: ["approval-required", "blocked"], expectedConfirmations: 1, expectedProviderCalls: 0 },
  { name: "manual unmatched confirmation error", config: {}, confirm: "error", expectedBlock: /confirmation failed/, expectedStatuses: ["approval-required", "blocked"], expectedConfirmations: 1, expectedProviderCalls: 0 },
  { name: "ask confirmation approved", config: { permissions: { ask: ["Bash(danger)"] } }, expectedStatuses: ["approval-required", "approved"], expectedConfirmations: 1, expectedProviderCalls: 0 },
  { name: "ask confirmation denied", config: { permissions: { ask: ["Bash(danger)"] } }, confirm: "no", expectedBlock: /user declined/, expectedStatuses: ["approval-required", "blocked"], expectedConfirmations: 1, expectedProviderCalls: 0 },
  { name: "ask confirmation error", config: { permissions: { ask: ["Bash(danger)"] } }, confirm: "error", expectedBlock: /confirmation failed/, expectedStatuses: ["approval-required", "blocked"], expectedConfirmations: 1, expectedProviderCalls: 0 },
  { name: "untrusted project allow", config: { projectPermissions: { allow: ["Bash(danger; echo harmless)"] } }, trusted: false, expectedStatuses: ["approval-required", "approved"], expectedConfirmations: 1, expectedProviderCalls: 0 },
  { name: "review approve", config: { reviewMode: "auto" }, reply: '{"decision":"approve","reason":"safe"}', expectedStatuses: ["guardian-running", "approved"], expectedConfirmations: 0, expectedProviderCalls: 2 },
  { name: "review revise", config: { reviewMode: "auto" }, reply: '{"decision":"revise","reason":"change target","constraint":"target","source":"user"}', expectedStatuses: ["guardian-running", "revision-requested", "guardian-running", "revision-requested", "approval-required", "approved"], expectedConfirmations: 1, expectedProviderCalls: 2 },
  { name: "review ask_user", config: { reviewMode: "auto" }, reply: '{"decision":"ask_user","reason":"confirm target"}', expectedStatuses: ["guardian-running", "approval-required", "approved"], expectedConfirmations: 1, expectedProviderCalls: 2 },
  { name: "review malformed response fallback", config: { reviewMode: "auto" }, reply: "not JSON", expectedStatuses: ["guardian-running", "approval-required", "approved"], expectedConfirmations: 1, expectedProviderCalls: 2 },
  { name: "review provider failure fallback", config: { reviewMode: "auto" }, reply: "provider-error", expectedStatuses: ["guardian-running", "approval-required", "approved"], expectedConfirmations: 1, expectedProviderCalls: 2 },
  { name: "invalid config", config: { invalid: true }, expectedBlock: /invalid config/, expectedStatuses: [], expectedConfirmations: 0, expectedProviderCalls: 0 },
  { name: "explicit off", config: { enabled: false }, expectedStatuses: [], expectedConfirmations: 0, expectedProviderCalls: 0 },
];

async function runFactoryScenario(scenario: Scenario, placement: "widget" | "toolRow") {
  const root = mkdtempSync(join(tmpdir(), "auto-approval-connected-parity-"));
  const home = join(root, "home");
  const globalDir = join(home, ".pi", "pi-auto-approval");
  mkdirSync(globalDir, { recursive: true });
  const configured = (scenario.config.permissions ?? {}) as { allow?: string[]; ask?: string[]; deny?: string[] };
  const global = {
    enabled: true,
    debug: true,
    reviewMode: "manual",
    permissions: { allow: ["Bash(seed)", ...(configured.allow ?? [])], ask: configured.ask ?? [], deny: configured.deny ?? [] },
    ui: { status: true, placement },
    ...(scenario.config.reviewMode ? { reviewMode: scenario.config.reviewMode } : {}),
    ...(scenario.config.enabled === false ? { enabled: false } : {}),
  };
  if (scenario.config.invalid) writeFileSync(join(globalDir, "auto-permissions.json"), "{");
  else {
    writeFileSync(join(globalDir, "auto-permissions.json"), JSON.stringify(global));
    if (scenario.config.projectPermissions) {
      mkdirSync(join(root, ".pi", "pi-auto-approval"), { recursive: true });
      writeFileSync(join(root, ".pi", "pi-auto-approval", "auto-permissions.json"), JSON.stringify({ permissions: scenario.config.projectPermissions }));
    }
  }
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    let resolver: ToolRendererResolver | undefined;
    const widgets: unknown[][] = [];
    const confirmations: unknown[][] = [];
    const providerRequests: unknown[] = [];
    const pi = {
      on: (name: string, handler: (...args: any[]) => unknown) => { handlers.set(name, handler); return () => {}; },
      registerCommand: () => {},
      getAllTools: () => [{ name: "bash", sourceInfo: { source: "builtin", path: "builtin:bash" } }],
      registerToolRenderer: (value: ToolRendererResolver) => { resolver = value; },
    } as unknown as ExtensionAPI;
    autoApproval(pi, [VERSION]);
    const ctx = {
      mode: "tui", hasUI: true, cwd: root, signal: undefined,
      model: { provider: "mock", id: "reviewer", api: "mock", baseUrl: "", contextWindow: 128_000 },
      isProjectTrusted: () => scenario.trusted !== false,
      sessionManager: { getSessionId: () => "parity-session", buildSessionProjection: () => ({ entries: [] }) },
      modelRegistry: {
        find: () => undefined,
        streamSimple: (_model: unknown, prompt: unknown, options: unknown) => {
          providerRequests.push({ prompt, options });
          return { result: async () => {
            if (scenario.reply === "provider-error") throw new Error("mock provider rejection");
            return { stopReason: "stop", content: [{ type: "text", text: scenario.reply ?? '{"decision":"approve","reason":"ok"}' }], usage: { input: 20, cacheRead: 0, cacheWrite: 0 } };
          } };
        },
      },
      ui: {
        confirm: async (...args: unknown[]) => {
          confirmations.push(args);
          if (scenario.confirm === "error") throw new Error("mock confirmation failure");
          return scenario.confirm !== "no";
        },
        setWidget: (...args: unknown[]) => widgets.push(args),
        setStatus: () => {}, notify: () => {},
      },
    } as unknown as ExtensionContext;
    const callTool = handlers.get("tool_call") as (event: ToolCallEvent, context: ExtensionContext) => Promise<unknown>;
    const callId = `scenario-${scenario.name}`;
    let row: ToolExecutionComponent | undefined;
    const rowFrames: string[] = [];
    if (placement === "toolRow" && !scenario.config.invalid && scenario.config.enabled !== false) {
      const seed = await callTool({ type: "tool_call", toolName: "bash", toolCallId: `${callId}-seed`, input: { command: "seed" } }, ctx);
      assert.equal(seed, undefined);
      assert.ok(resolver, "factory registers the public renderer resolver");
      const extension = {
        path: "/test/connected-parity.ts", resolvedPath: "/test/connected-parity.ts",
        sourceInfo: { source: "extension", path: "/test/connected-parity.ts", scope: "user" as const, origin: "top-level" as const },
        handlers: new Map(), tools: new Map(), messageRenderers: new Map(), toolRenderers: [resolver!],
        commands: new Map(), flags: new Map(), shortcuts: new Map(),
      };
      const runner = new ExtensionRunner([extension], createExtensionRuntime(), root, {} as never, {} as never);
      const renderers = runner.resolveToolRenderers("bash", () => nativeBash as unknown as ToolRenderers)!;
      row = new ToolExecutionComponent("bash", callId, { command: scenario.command ?? "danger; echo harmless" }, {}, renderers as never, { requestRender: () => { if (row) rowFrames.push(row.render(100).join("\\n")); } } as never, root);
      row.render(100);
    }
    const widgetBaseline = widgets.length;
    const frameBaseline = rowFrames.length;
    const outcome = await callTool({ type: "tool_call", toolName: "bash", toolCallId: callId, input: { command: scenario.command ?? "danger; echo harmless" } }, ctx);
    if (scenario.expectedBlock) assert.match(String((outcome as { reason?: string } | undefined)?.reason), scenario.expectedBlock, scenario.name);
    else assert.equal(outcome, undefined, scenario.name);
    assert.equal(confirmations.length, scenario.expectedConfirmations, `${scenario.name}: actual factory confirmation count`);
    assert.equal(providerRequests.length, scenario.expectedProviderCalls, `${scenario.name}: actual mocked provider call count`);
    const callWidgets = widgets.slice(widgetBaseline);
    const callFrames = rowFrames.slice(frameBaseline);
    if (!scenario.expectedStatuses.length) {
      assert.equal(callWidgets.length, 0, `${scenario.name} ${placement}: no status widget publication expected`);
      assert.equal(callFrames.length, 0, `${scenario.name} ${placement}: no status row transition expected`);
    }
    const visible = row ? [...callFrames, row.render(100).join("\n")].join("\n") : callWidgets.map((call) => JSON.stringify(call)).join("\n");
    for (const state of scenario.expectedStatuses) {
      const stateWords: Record<string, string> = {
        "approval-required": "approval required", "guardian-running": "guardian running", "approved": "approved",
        "blocked": "blocked", "revision-requested": "revision requested",
      };
      const renderedState = placement === "widget"
        ? state === "approved" ? "approved" : state === "blocked" || state === "revision-requested" ? "blocked" : "reviewing"
        : stateWords[state]!;
      assert.match(visible, new RegExp(renderedState), `${scenario.name} ${placement}: status ${state} must reach ${row ? "the ready native row" : "the widget"}`);
    }
    if (placement === "toolRow" && row && scenario.expectedStatuses.length) {
      assert.deepEqual(callWidgets.filter((call) => Array.isArray(call[1]) && call[1].some((line) => typeof line === "string" && line.trim().length > 0)), [], `${scenario.name}: ready-row must not publish a status widget`);
    }
    const observed = row
      ? callFrames.flatMap((frame) => {
          const found = ["approval required", "guardian running", "approved", "blocked", "revision requested"].find((state) => frame.includes(state));
          const normalized = found === "approval required" || found === "guardian running" ? "reviewing" : found === "revision requested" ? "blocked" : found;
          return normalized ? [normalized] : [];
        }).filter((state, index, all) => index === 0 || state !== all[index - 1])
      : callWidgets.flatMap((call) => {
          const content = Array.isArray(call[1]) ? call[1].join(" ") : "";
          if (!content.trim()) return [];
          if (content.includes("approved")) return ["approved"];
          if (content.includes("blocked")) return ["blocked"];
          if (content.includes("reviewing")) return ["reviewing"];
          return [];
        }).filter((state, index, all) => index === 0 || state !== all[index - 1]);
    const normalizedExpected = scenario.expectedStatuses.map((state) => placement === "widget"
      ? state === "approved" ? "approved" : state === "blocked" || state === "revision-requested" ? "blocked" : "reviewing"
      : state === "approval-required" || state === "guardian-running" ? "reviewing" : state === "revision-requested" ? "blocked" : state.replaceAll("-", " "))
      .filter((state, index, all) => index === 0 || state !== all[index - 1]);
    assert.deepEqual(observed, normalizedExpected, `${scenario.name} ${placement}: ordered observed status transitions`);
    const normalize = (value: unknown): unknown => {
      if (value === undefined) return undefined;
      const sessionIds = new Map<string, string>();
      const parsed = JSON.parse(JSON.stringify(value).replaceAll(root, "<project>"));
      const stripVolatile = (item: unknown): unknown => {
        if (Array.isArray(item)) return item.map(stripVolatile);
        if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).filter(([key]) => !["timestamp", "signal"].includes(key)).map(([key, nested]) => {
          if (key !== "sessionId" || typeof nested !== "string") return [key, stripVolatile(nested)];
          let canonical = sessionIds.get(nested);
          if (!canonical) {
            canonical = `session-${sessionIds.size + 1}`;
            sessionIds.set(nested, canonical);
          }
          return [key, canonical];
        }));
        return item;
      };
      return stripVolatile(parsed);
    };
    return {
      outcome: normalize(outcome),
      confirmations: normalize(confirmations.map((args) => args.slice(0, 2))),
      providerRequests: normalize(providerRequests),
      states: observed,
      visible,
    };
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

const REVIEW_REPLY = { role: "assistant", content: [{ type: "text", text: '{"decision":"approve","reason":"ok"}' }], stopReason: "stop", usage: { input: 20, cacheRead: 0, cacheWrite: 0 } };

async function createLifecycleHarness(
  placement: "widget" | "toolRow",
  options: {
    signal?: AbortSignal;
    reviewer?: Record<string, unknown>;
    reviewEvidence?: Record<string, unknown>;
    projection?: () => unknown[];
    confirm?: (...args: unknown[]) => Promise<boolean>;
    provider?: (request: unknown, call: number) => Promise<unknown>;
    contextWindow?: number;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "auto-approval-connected-lifecycle-"));
  const home = join(root, "home");
  const globalDir = join(home, ".pi", "pi-auto-approval");
  mkdirSync(globalDir, { recursive: true });
  writeFileSync(join(globalDir, "auto-permissions.json"), JSON.stringify({
    enabled: true,
    debug: true,
    reviewMode: "auto",
    permissions: { allow: ["Bash(seed)"] },
    ui: { status: true, placement },
    reviewer: options.reviewer,
    reviewEvidence: options.reviewEvidence,
  }));
  const previous = process.env.HOME;
  process.env.HOME = home;
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let resolver: ToolRendererResolver | undefined;
  const widgets: unknown[][] = [];
  const confirmations: unknown[][] = [];
  const providerRequests: Array<{ model: unknown[]; prompt: any; options: any; reply?: unknown }> = [];
  const selectedModel = { provider: "mock", id: "gpt-6-luna", api: "mock", baseUrl: "", contextWindow: options.contextWindow ?? 128_000 };
  const pi = {
    on: (name: string, handler: (...args: any[]) => unknown) => { handlers.set(name, handler); return () => {}; },
    registerCommand: () => {},
    getAllTools: () => [{ name: "bash", sourceInfo: { source: "builtin", path: "builtin:bash" } }],
    registerToolRenderer: (value: ToolRendererResolver) => { resolver = value; },
  } as unknown as ExtensionAPI;
  autoApproval(pi, [VERSION]);
  const ctx = {
    mode: "tui", hasUI: true, cwd: root, signal: options.signal,
    model: { provider: "mock", id: "reviewer", api: "mock", baseUrl: "", contextWindow: options.contextWindow ?? 128_000 },
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "parity-session", buildSessionProjection: () => ({ entries: options.projection?.() ?? [] }) },
    modelRegistry: {
      find: (provider: string, id: string) => provider === selectedModel.provider && id === selectedModel.id ? selectedModel : undefined,
      streamSimple: (model: unknown, prompt: unknown, modelOptions: unknown) => {
        const { provider, id } = model as { provider: string; id: string };
        const request = { model: [provider, id], prompt: structuredClone(prompt), options: modelOptions, reply: undefined as unknown };
        providerRequests.push(request);
        return { result: async () => {
          const reply = options.provider ? await options.provider(request, providerRequests.length) : structuredClone(REVIEW_REPLY);
          request.reply = structuredClone(reply);
          return reply;
        } };
      },
    },
    ui: {
      confirm: async (...args: unknown[]) => {
        confirmations.push(args);
        return options.confirm ? options.confirm(...args) : true;
      },
      setWidget: (...args: unknown[]) => widgets.push(args),
      setStatus: () => {}, notify: () => {},
    },
  } as unknown as ExtensionContext;
  const callTool = handlers.get("tool_call") as (event: ToolCallEvent, context: ExtensionContext) => Promise<unknown>;
  await callTool({ type: "tool_call", toolName: "bash", toolCallId: "lifecycle-seed", input: { command: "seed" } }, ctx);
  providerRequests.length = 0;
  widgets.length = 0;
  let rowId = 0;
  const rows: Array<{ row: ToolExecutionComponent; frames: string[] }> = [];
  const call = async (command = "danger; echo harmless") => {
    const toolCallId = `lifecycle-${++rowId}`;
    let row: ToolExecutionComponent | undefined;
    const frames: string[] = [];
    if (placement === "toolRow") {
      assert.ok(resolver);
      const extension = {
        path: "/test/connected-parity.ts", resolvedPath: "/test/connected-parity.ts",
        sourceInfo: { source: "extension", path: "/test/connected-parity.ts", scope: "user" as const, origin: "top-level" as const },
        handlers: new Map(), tools: new Map(), messageRenderers: new Map(), toolRenderers: [resolver!],
        commands: new Map(), flags: new Map(), shortcuts: new Map(),
      };
      const runner = new ExtensionRunner([extension], createExtensionRuntime(), root, {} as never, {} as never);
      const renderers = runner.resolveToolRenderers("bash", () => nativeBash as unknown as ToolRenderers)!;
      row = new ToolExecutionComponent("bash", toolCallId, { command }, {}, renderers as never, { requestRender: () => { if (row) frames.push(row.render(100).join("\\n")); } } as never, root);
      row.render(100);
      rows.push({ row, frames });
    }
    const widgetStart = widgets.length;
    const frameStart = frames.length;
    const result = await callTool({ type: "tool_call", toolName: "bash", toolCallId, input: { command } }, ctx);
    return { result, widgets: widgets.slice(widgetStart), frames: frames.slice(frameStart), row, confirmations, providerRequests, rows };
  };
  return {
    call,
    confirmations,
    providerRequests,
    widgets,
    rows,
    cancel: () => handlers.get("session_start")?.({}, ctx),
    close: () => {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const RAW_ROW_STATES = ["guardian running", "approval required", "revision requested", "approved", "blocked"];

function rowState(frame: string): string | undefined {
  const state = RAW_ROW_STATES.find((candidate) => frame.includes(candidate));
  return state && frame.includes("Cancelled") ? `${state} + Cancelled` : state;
}

function widgetState(item: unknown[]): string | undefined {
  const text = Array.isArray(item[1]) ? item[1].join("\n") : "";
  const state = ["reviewing", "approved", "blocked"].find((candidate) => text.includes(`auto-approval: ${candidate}`));
  return state && text.includes("Cancelled") ? `${state} + Cancelled` : state;
}

// Collapses repeated renders of the same status into one publication/row transition.
function transitions(states: Array<string | undefined>): string[] {
  const observed = states.filter((state): state is string => state !== undefined);
  return observed.filter((state, index) => index === 0 || state !== observed[index - 1]);
}

function canonicalState(state: string | undefined): string | undefined {
  return state?.replace("guardian running", "reviewing").replace("approval required", "reviewing").replace("revision requested", "blocked");
}

function observedCallStates(placement: "widget" | "toolRow", result: { widgets: unknown[][]; frames: string[] }, canonicalize = false): string[] {
  const states = placement === "widget" ? result.widgets.map(widgetState) : result.frames.map(rowState);
  return transitions(canonicalize ? states.map(canonicalState) : states);
}

function liveWidgetStates(widgets: unknown[][], key: unknown): string[] {
  return transitions(widgets.filter((item) => item[0] === key).map(widgetState));
}

// Strips only timestamps, the temporary project path, and signal identity; reviewer session IDs become first-seen canonical names.
function traceNormalizer() {
  const sessions = new Map<string, string>();
  const strip = (value: unknown): any => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "timestamp").map(([key, nested]) => [key, strip(nested)]));
    return typeof value === "string" ? value.replace(/auto-approval-connected-lifecycle-[A-Za-z0-9]+/g, "<project>") : value;
  };
  const request = (raw: { model: unknown[]; prompt: unknown; options: any }) => {
    const { signal, ...options } = raw.options;
    const id = raw.options.sessionId as string;
    if (!sessions.has(id)) sessions.set(id, `session-${sessions.size + 1}`);
    return {
      model: raw.model,
      prompt: strip(raw.prompt),
      options: { ...options, sessionId: sessions.get(id), liveSignal: signal instanceof AbortSignal && !signal.aborted },
    };
  };
  return { request, strip };
}

test("connected abort cancels an in-flight fallback confirmation and retains its lock until settlement", async () => {
  for (const placement of ["widget", "toolRow"] as const) {
    let finishPrompt!: (approved: boolean) => void;
    let promptEntered!: () => void;
    const entered = new Promise<void>((resolve) => { promptEntered = resolve; });
    let promptCalls = 0;
    const harness = await createLifecycleHarness(placement, {
      provider: async () => ({ stopReason: "stop", content: [{ type: "text", text: "not JSON" }] }),
      confirm: async () => {
        promptCalls++;
        if (promptCalls > 1) return true;
        promptEntered();
        return new Promise<boolean>((resolve) => { finishPrompt = resolve; });
      },
    });
    try {
      const first = harness.call();
      await entered;
      harness.cancel();
      const aborted = await first;
      assert.deepEqual(aborted.result, { block: true, reason: "auto-approval: confirmation failed" });
      const widgetKey = aborted.widgets[0]?.[0];
      const competing = await harness.call();
      assert.deepEqual(competing.result, { block: true, reason: "Automatic review failed: reviewer returned no JSON object (confirmation failed)" });
      assert.equal(promptCalls, 1, `${placement}: lock must reject confirmation while the original dialog is unresolved`);
      finishPrompt(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      const lateVisual = [...harness.widgets.map((item) => JSON.stringify(item)), ...harness.rows.flatMap(({ frames }) => frames)].join("\\n");
      assert.doesNotMatch(lateVisual, /approved/);
      const firstTransitions = placement === "widget"
        ? liveWidgetStates(harness.widgets, widgetKey)
        : transitions(harness.rows[0]!.frames.map(rowState));
      assert.deepEqual(firstTransitions, placement === "widget"
        ? ["reviewing", "blocked + Cancelled"]
        : ["guardian running", "approval required", "blocked + Cancelled"], `${placement}: exactly one attributed terminal Cancelled transition, no late approval`);
      if (placement === "toolRow") {
        assert.deepEqual(harness.widgets.filter((item) => Array.isArray(item[1]) && item[1].some((line) => typeof line === "string" && line.trim())), [], `${placement}: settled cancelled confirmation has no widget fallback`);
      }
      const recovered = await harness.call();
      assert.equal(recovered.result, undefined, `${placement}: settled confirmation releases the lock`);
      assert.equal(promptCalls, 2);
      assert.equal(harness.providerRequests.length, 6, "three original calls review two components each");
    } finally {
      harness.close();
    }
  }
});

test("connected reviewer cancellation ignores a late approval and permits a fresh retry", async () => {
  for (const placement of ["widget", "toolRow"] as const) {
    let finishReview!: (result: unknown) => void;
    let reviewerStarted!: () => void;
    const started = new Promise<void>((resolve) => { reviewerStarted = resolve; });
    let providerCalls = 0;
    const harness = await createLifecycleHarness(placement, {
      provider: async () => {
        providerCalls++;
        if (providerCalls === 1) {
          reviewerStarted();
          return new Promise((resolve) => { finishReview = resolve; });
        }
        return { stopReason: "stop", content: [{ type: "text", text: '{"decision":"approve","reason":"fresh"}' }], usage: { input: 10, cacheRead: 0, cacheWrite: 0 } };
      },
    });
    try {
      const abandoned = harness.call();
      await started;
      harness.cancel();
      const cancelled = await abandoned;
      assert.deepEqual(cancelled.result, { block: true, reason: "auto-approval: confirmation failed" });
      assert.equal(harness.confirmations.length, 0);
      const widgetKey = cancelled.widgets[0]?.[0];
      finishReview({ stopReason: "stop", content: [{ type: "text", text: '{"decision":"approve","reason":"late"}' }], usage: { input: 10, cacheRead: 0, cacheWrite: 0 } });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      const liveTransitions = placement === "widget"
        ? liveWidgetStates(harness.widgets, widgetKey)
        : transitions(harness.rows[0]!.frames.map(rowState));
      assert.deepEqual(liveTransitions, placement === "widget"
        ? ["reviewing", "blocked + Cancelled"]
        : ["guardian running", "blocked + Cancelled"], `${placement}: exactly one attributed Cancelled transition, no late approval publication`);
      const firstVisual = [...harness.widgets.map((item) => JSON.stringify(item)), ...harness.rows.flatMap(({ frames }) => frames)].join("\\n");
      assert.doesNotMatch(firstVisual, /approved|late/);
      assert.throws(() => assert.doesNotMatch(`${firstVisual}\\napproved [late]`, /approved|late/), assert.AssertionError, `${placement}: lifecycle assertion rejects a simulated late approval publication`);
      if (placement === "toolRow") {
        assert.match(harness.rows[0]!.frames.at(-1)!, /danger; echo harmless/, `${placement}: cancellation is attributed to the ready tool call`);
        assert.deepEqual(harness.widgets.filter((item) => Array.isArray(item[1]) && item[1].some((line) => typeof line === "string" && line.trim())), [], `${placement}: ready row has no content-bearing widget fallback`);
      }
      assert.equal(harness.providerRequests.length, 1, `${placement}: abandoned approval cannot trigger another provider call`);
      const fresh = await harness.call();
      assert.equal(fresh.result, undefined);
      assert.equal(harness.providerRequests.length, 3, `${placement}: fresh retry reviews both components`);
    } finally {
      harness.close();
    }
  }
});

test("connected reviewer projects full and delta evidence, reuses lineage, and invalidates changed evidence", async () => {
  const placementTraces: unknown[][] = [];
  for (const placement of ["widget", "toolRow"] as const) {
    const evidence: string[] = ["user-authorized initial action"];
    const harness = await createLifecycleHarness(placement, {
      reviewer: { provider: "mock", model: "gpt-6-luna", reasoningEffort: "medium", timeoutMs: 30_000 },
      reviewEvidence: { projectInstructions: false },
      projection: () => evidence.map((content, index) => ({
        sourceEntry: { type: "message", id: `user-${index + 1}` },
        messages: [{ role: "user", content }],
      })),
    });
    const normalize = traceNormalizer();
    const trace: unknown[] = [];
    const runCall = async () => {
      const before = harness.providerRequests.length;
      const result = await harness.call();
      const raw = harness.providerRequests.slice(before);
      trace.push({
        outcome: result.result ?? "allowed",
        confirmations: harness.confirmations.length,
        states: observedCallStates(placement, result, true),
        requests: raw.map((request) => normalize.request(request)),
      });
      return { result, raw };
    };
    try {
      const first = await runCall();
      assert.equal(first.result.result, undefined);
      assert.equal(first.raw.length, 2);
      for (const [index, raw] of first.raw.entries()) {
        const prompt = raw.prompt.messages.at(-1).content[0].text;
        const card = JSON.parse(prompt.split("<LATEST_PROPOSED_ACTION>\n")[1].split("\n</LATEST_PROPOSED_ACTION>")[0]);
        assert.equal(card.command, index === 0 ? "danger" : "echo harmless");
        assert.equal(card.component.originalCommand, "danger; echo harmless");
        assert.equal(card.component.index, index + 1);
        assert.equal(card.component.count, 2);
        assert.equal(card.component.originalCommand.slice(card.component.start, card.component.end), card.command);
        assert.ok(card.component.context.length);
        assert.match(prompt, /initial context only/);
        assert.match(prompt, /preceding commands have not executed/);
        assert.match(prompt, /may change shell state/);
      }
      const firstRaw = first.raw[0]!;
      assert.deepEqual(firstRaw.model, ["mock", "gpt-6-luna"], "provider receives the configured reviewer model");
      assert.equal(firstRaw.options.reasoning, "medium");
      assert.equal(firstRaw.options.cacheRetention, "long");
      const firstMessages = normalize.strip(firstRaw.prompt.messages);
      assert.equal(firstMessages.length, 1);
      assert.match(firstMessages[0].content[0].text, /^Review the latest proposed action/);
      assert.match(firstMessages[0].content[0].text, /user-authorized initial action/);

      evidence.push("user added a follow-up constraint");
      const second = await runCall();
      assert.equal(second.result.result, undefined);
      assert.equal(second.raw.length, 2);
      const secondRaw = second.raw[0]!;
      assert.equal(secondRaw.options.sessionId, firstRaw.options.sessionId, "successful projected evidence extends the same reviewer session");
      const secondMessages = normalize.strip(secondRaw.prompt.messages);
      assert.deepEqual(secondMessages.slice(0, 4), normalize.strip([...first.raw[1]!.prompt.messages, first.raw[1]!.reply]), "second request retains the exact first user request and reviewer reply");
      assert.equal(secondMessages.length, 5, "next original request follows both component reviews");
      assert.equal(secondMessages[4].role, "user");
      assert.match(secondMessages[4].content[0].text, /continues the same conversation/);
      assert.match(secondMessages[4].content[0].text, /user added a follow-up constraint/);
      assert.doesNotMatch(secondMessages[4].content[0].text, /user-authorized initial action/, "delta carries only new evidence");

      evidence[0] = "user replaced prior authorization evidence";
      const third = await runCall();
      assert.equal(third.result.result, undefined);
      assert.equal(third.raw.length, 2);
      const thirdRaw = third.raw[0]!;
      const thirdMessages = normalize.strip(thirdRaw.prompt.messages);
      assert.equal(thirdMessages.length, 1, "changed prior evidence discards old assistant/reviewer lineage");
      assert.match(thirdMessages[0].content[0].text, /^Review the latest proposed action/);
      assert.match(thirdMessages[0].content[0].text, /user replaced prior authorization evidence/);
      assert.doesNotMatch(thirdMessages[0].content[0].text, /user-authorized initial action/, "invalidated evidence is not resent");
      assert.notEqual(thirdRaw.options.sessionId, firstRaw.options.sessionId, "evidence invalidation starts a fresh reviewer session");
      assert.equal(harness.providerRequests.length, 6);
      assert.equal(harness.confirmations.length, 0);
      assert.ok(harness.providerRequests.every((request) => request.options.signal instanceof AbortSignal && !request.options.signal.aborted));
      placementTraces.push(trace);
    } finally {
      harness.close();
    }
  }
  assert.equal(placementTraces[0]!.length, 3);
  assert.deepEqual(placementTraces[1], placementTraces[0], "complete outcomes, confirmations, observed states, models, options, prompts, and canonical session relationships match across placements");
});

test("connected fresh evidence overflow confirms or blocks with the exact budget reason on both placements", async () => {
  for (const placement of ["widget", "toolRow"] as const) {
    for (const approved of [true, false]) {
      const harness = await createLifecycleHarness(placement, {
        reviewer: { provider: "mock", model: "gpt-6-luna", reasoningEffort: "medium", timeoutMs: 30_000 },
        reviewEvidence: { projectInstructions: false },
        contextWindow: 5_000,
        projection: () => [{
          sourceEntry: { type: "message", id: "fresh-overflow" },
          messages: [{ role: "user", content: `projected authorization ${"e".repeat(20_000)}` }],
        }],
        confirm: async () => approved,
      });
      try {
        const result = await harness.call();
        assert.equal(harness.providerRequests.length, 0, `${placement}/${approved}: oversized fresh prompt never calls the provider`);
        assert.equal(harness.confirmations.length, 1);
        assert.equal(harness.confirmations[0]![0], "Approve command?");
        assert.match(String(harness.confirmations[0]![1]), /^Automatic review failed: compact review evidence exceeds the review model's safe context budget\n\ndanger; echo harmless$/);
        assert.deepEqual(result.result, approved ? undefined : { block: true, reason: "Automatic review failed: compact review evidence exceeds the review model's safe context budget (user declined)" });
        assert.deepEqual(observedCallStates(placement, result), placement === "widget"
          ? ["reviewing", approved ? "approved" : "blocked"]
          : ["guardian running", "approval required", approved ? "approved" : "blocked"], `${placement}/${approved}: ordered observed states`);
        if (placement === "toolRow") {
          assert.deepEqual(result.widgets.filter((item) => Array.isArray(item[1]) && item[1].some((line) => typeof line === "string" && line.trim())), [], `${placement}: ready row has no content-bearing widget fallback`);
        }
      } finally {
        harness.close();
      }
    }
  }
});

test("connected accumulated prompt budget retries fresh with projected evidence on both placements", async () => {
  const placementTraces: unknown[][] = [];
  for (const placement of ["widget", "toolRow"] as const) {
    const evidence: string[] = [];
    const harness = await createLifecycleHarness(placement, {
      reviewer: { provider: "mock", model: "gpt-6-luna", reasoningEffort: "medium", timeoutMs: 30_000 },
      reviewEvidence: { projectInstructions: false },
      contextWindow: 6_000,
      projection: () => evidence.map((content, index) => ({
        sourceEntry: { type: "message", id: `budget-${index + 1}` },
        messages: [{ role: "user", content }],
      })),
    });
    const normalize = traceNormalizer();
    const trace: unknown[] = [];
    try {
      const raws: any[] = [];
      for (let index = 0; index < 6; index++) {
        evidence.push(`projected authorization ${index + 1}: ${"e".repeat(1_200)}`);
        const before = harness.providerRequests.length;
        const result = await harness.call();
        assert.equal(result.result, undefined, `${placement}: evidence ${index + 1} remains reviewable`);
        const raw = harness.providerRequests.slice(before);
        assert.equal(raw.length, 2, `${placement}: evidence ${index + 1} reviews both components`);
        trace.push({
          outcome: result.result ?? "allowed",
          confirmations: harness.confirmations.length,
          states: observedCallStates(placement, result, true),
          requests: raw.map((request) => normalize.request(request)),
        });
        raws.push(...raw);
      }
      assert.equal(harness.confirmations.length, 0, `${placement}: accumulated budget uses fresh retry instead of fallback confirmation`);
      assert.equal(harness.providerRequests.length, 12);
      for (const raw of raws) {
        assert.equal(raw.options.reasoning, "medium");
        assert.equal(raw.options.cacheRetention, "long");
        assert.ok(raw.options.signal instanceof AbortSignal && !raw.options.signal.aborted);
        assert.deepEqual(raw.model, ["mock", "gpt-6-luna"]);
      }
      // Every continuation must retain the exact previous canonical request and reviewer reply; every reset must send one compact full prompt.
      let resets = 0;
      for (let index = 0; index < raws.length; index++) {
        const current = raws[index];
        const messages = normalize.strip(current.prompt.messages);
        const latest = messages.at(-1);
        if (index > 0 && current.options.sessionId === raws[index - 1].options.sessionId) {
          const previous = normalize.strip(raws[index - 1].prompt.messages);
          assert.deepEqual(messages.slice(0, previous.length + 1), [...previous, normalize.strip(raws[index - 1].reply)], `${placement}: call ${index + 1} retains exact previous request and reviewer reply`);
          assert.equal(messages.length, previous.length + 2, `${placement}: call ${index + 1} appends exactly reviewer reply and one user delta`);
          assert.equal(latest.role, "user");
          assert.match(latest.content[0].text, /continues the same conversation/);
          if (index % 2 === 0) assert.match(latest.content[0].text, new RegExp(`projected authorization ${Math.floor(index / 2) + 1}:`));
          else assert.match(latest.content[0].text, /<no new finalized evidence>/);
        } else {
          resets++;
          assert.equal(messages.length, 1, `${placement}: call ${index + 1} reset sends a compact full prompt, not accumulated history`);
          assert.match(messages[0].content[0].text, /^Review the latest proposed action/);
          assert.match(messages[0].content[0].text, new RegExp(`projected authorization ${Math.floor(index / 2) + 1}:`));
        }
      }
      assert.ok(resets > 1, `${placement}: accumulated budget overflow resets reviewer lineage`);
      placementTraces.push(trace);
    } finally {
      harness.close();
    }
  }
  assert.deepEqual(placementTraces[1], placementTraces[0], "complete accumulated-budget traces (models, options, prompts, outcomes, states, canonical sessions) match across placements");
});

test("connected reviewer timeout falls back to confirmation and ignores a late deferred reviewer reply on both placements", async () => {
  for (const placement of ["widget", "toolRow"] as const) {
    let settleLate!: (value: unknown) => void;
    const harness = await createLifecycleHarness(placement, {
      reviewer: { timeoutMs: 1_000 },
      provider: () => new Promise((resolve) => { settleLate = resolve; }),
    });
    try {
      const result = await harness.call();
      assert.equal(result.result, undefined, placement);
      assert.equal(harness.providerRequests.length, 2, `${placement}: both components time out before confirmation`);
      assert.equal(harness.confirmations.length, 1, `${placement}: timed-out review asks for manual confirmation`);
      assert.match(String(harness.confirmations[0]?.[1]), /Automatic review failed: review timed out or was cancelled/);
      const expectedStates = placement === "widget"
        ? ["reviewing", "approved"]
        : ["guardian running", "approval required", "approved"];
      assert.deepEqual(observedCallStates(placement, result), expectedStates, `${placement}: fallback states before settlement`);
      const widgetsBefore = harness.widgets.length;
      const framesBefore = harness.rows[0]?.frames.length ?? 0;
      settleLate({ ...REVIEW_REPLY, content: [{ type: "text", text: '{"decision":"approve","reason":"late"}' }] });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(harness.widgets.length, widgetsBefore, `${placement}: late reviewer reply publishes no widget`);
      assert.equal(harness.rows[0]?.frames.length ?? 0, framesBefore, `${placement}: late reviewer reply publishes no row frame`);
      assert.equal(harness.providerRequests.length, 2, `${placement}: late reply causes no further provider work`);
      assert.equal(harness.confirmations.length, 1, `${placement}: late reply causes no further confirmation`);
      if (placement === "toolRow") {
        assert.deepEqual(harness.widgets.filter((item) => Array.isArray(item[1]) && item[1].some((line) => typeof line === "string" && line.trim())), [], `${placement}: ready row has no content-bearing widget fallback`);
      }
    } finally {
      harness.close();
    }
  }
});

test("actual factory and router preserve approval outcomes on widget and confirmed-ready native rows", async () => {
  for (const scenario of scenarios) {
    const widget = await runFactoryScenario(scenario, "widget");
    const row = await runFactoryScenario(scenario, "toolRow");
    assert.deepEqual(row.outcome, widget.outcome, `${scenario.name}: actual decision/reason parity`);
    assert.deepEqual(row.confirmations, widget.confirmations, `${scenario.name}: actual confirmation argument parity`);
    assert.deepEqual(row.providerRequests, widget.providerRequests, `${scenario.name}: actual mocked provider request parity`);
    assert.deepEqual(row.states, widget.states, `${scenario.name}: observed route state parity`);
  }
});
