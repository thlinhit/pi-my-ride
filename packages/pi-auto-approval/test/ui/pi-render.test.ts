import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  createBashToolDefinition,
  createExtensionRuntime,
  ExtensionRunner,
  initTheme,
  ToolExecutionComponent,
  VERSION,
} from "@earendil-works/pi-coding-agent";

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolRendererResolver,
  ToolRenderers,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import type { ConfigUi } from "../../src/config.ts";
import autoApproval from "../../src/index.ts";
import { createReviewDisplay } from "../../src/ui/display.ts";
import { createRowStore, VERIFIED_PI_VERSIONS, wrapNative } from "../../src/ui/rows.ts";
import { formatStatusLines, type ReviewStatus } from "../../src/ui/status.ts";

initTheme("dark", false);

const toolRowUi: ConfigUi = { status: true, placement: "toolRow" };
const cwd = process.cwd();
const nativeDefinition = createBashToolDefinition(cwd);
const nativeExecute = nativeDefinition.execute;

function render(component: ToolExecutionComponent): string[] {
  return component.render(100);
}

function withoutStatus(lines: string[], status: ReviewStatus): string[] {
  const block = formatStatusLines(status);
  const start = lines.findIndex((line) => line.includes(block[0]));
  assert.notEqual(start, -1, `expected the inserted Text block ${JSON.stringify(block)} in ${JSON.stringify(lines)}`);
  for (let offset = 1; offset < block.length; offset++) {
    assert.ok(lines[start + offset]?.includes(block[offset]), `expected inserted status line ${block[offset]}`);
  }
  let end = start + block.length;
  const padding = lines[end];
  if (padding && /^\u001b\[[0-9;]*m *\u001b\[[0-9;]*m$/.test(padding)) {
    assert.equal(lines[end + 1], padding, "expected only the renderer's paired status-container padding");
    end += 2;
  }
  return [...lines.slice(0, start), ...lines.slice(end)];
}

function context(): ExtensionContext {
  return {
    mode: "tui",
    hasUI: true,
    cwd,
    ui: {
      notify: () => {},
      setWidget: () => {},
    },
  } as unknown as ExtensionContext;
}

function createApi(renderer: { current?: ToolRendererResolver }): ExtensionAPI {
  const bash = {
    name: "bash",
    sourceInfo: { source: "builtin", path: "/native/bash" },
  };
  return {
    getAllTools: () => [bash],
    registerToolRenderer: (resolver: ToolRendererResolver) => { renderer.current = resolver; },
  } as unknown as ExtensionAPI;
}

function status(toolCallId: string, overrides: Partial<ReviewStatus> = {}): ReviewStatus {
  return {
    toolCallId,
    state: "guardian-running",
    label: "native parity",
    ...overrides,
  };
}

function resolveWrapped(renderer: ToolRendererResolver): ToolRenderers {
  const resolved = renderer("bash", () => nativeDefinition as unknown as ToolRenderers);
  assert.ok(resolved?.renderCall);
  assert.notEqual(resolved.renderCall, nativeDefinition.renderCall);
  assert.equal(resolved.renderResult, nativeDefinition.renderResult);
  assert.equal(nativeDefinition.execute, nativeExecute);
  return { ...nativeDefinition, ...resolved } as unknown as ToolRenderers;
}

function exerciseResult(component: ToolExecutionComponent, isError = false): void {
  component.markExecutionStarted();
  component.setArgsComplete();
  component.updateResult({
    content: [{ type: "text", text: isError ? "error output\n".repeat(8) : "short output" }],
    isError,
  }, true);
  component.updateResult({
    content: [{ type: "text", text: isError ? "error output\n".repeat(8) : "short output" }],
    isError,
    durationMs: 1234,
  });
}

test("actual factory keeps unverified row placement on widget fallback", async (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), "auto-approval-renderer-"));
  const agentDir = join(root, "global");
  const home = join(root, "home");
  const globalDir = join(home, ".pi", "pi-auto-approval");
  mkdirSync(agentDir);
  mkdirSync(globalDir, { recursive: true });
  writeFileSync(join(globalDir, "auto-permissions.json"), JSON.stringify({
    enabled: true,
    reviewMode: "manual",
    permissions: {},
    ui: { status: true, placement: "toolRow" },
  }));
  const previousHome = process.env.HOME;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });

  const handlers = new Map<string, (event: ToolCallEvent, ctx: unknown) => Promise<unknown>>();
  const renderer: { current?: ToolRendererResolver } = {};
  const widgets: unknown[] = [];
  const pi = {
    on: (eventName: string, handler: (event: ToolCallEvent, ctx: unknown) => Promise<unknown>) => {
      handlers.set(eventName, handler);
      return () => {};
    },
    registerCommand: () => {},
    getAllTools: () => [{ name: "bash", sourceInfo: { source: "builtin", path: "builtin:bash" } }],
    registerToolRenderer: (resolver: ToolRendererResolver) => { renderer.current = resolver; },
  } as unknown as ExtensionAPI;
  autoApproval(pi);
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: root,
    signal: undefined,
    isProjectTrusted: () => true,
    ui: {
      confirm: async () => true,
      setWidget: (...args: unknown[]) => widgets.push(args),
      setStatus: () => {},
      notify: () => {},
    },
  } as unknown as ExtensionContext;

  await handlers.get("tool_call")!({ type: "tool_call", toolName: "bash", toolCallId: "factory-first", input: { command: "echo first" } }, ctx);
  assert.notEqual(renderer.current, undefined, "the verified production version registers the renderer");
  assert.equal(widgets.length > 0, true, "the first call falls back until its row is ready");
  assert.equal(widgets.some((call) => String((call as unknown[])[1]).includes("auto-approval")), true);
  assert.equal(widgets.some((call) => JSON.stringify(call).includes("Unmatched Bash command")), true);
});

test("uses the actual ExtensionRunner resolver and actual tool-row factory placement", () => {
  const store = createRowStore();
  const resolver: ToolRendererResolver = (toolName, next) => {
    const renderers = next();
    if (toolName !== "bash" || !renderers?.renderCall) return renderers;
    return { ...renderers, renderCall: wrapNative(renderers.renderCall, store) };
  };
  const runtime = createExtensionRuntime();
  const extension = {
    path: "/test/renderer.ts",
    resolvedPath: "/test/renderer.ts",
    sourceInfo: { source: "extension", path: "/test/renderer.ts", scope: "project" as const, origin: "top-level" as const },
    handlers: new Map(),
    tools: new Map(),
    messageRenderers: new Map(),
    toolRenderers: [resolver],
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
  const runner = new ExtensionRunner([extension], runtime, cwd, {} as never, {} as never);
  const resolved = runner.resolveToolRenderers("bash", () => nativeDefinition as unknown as ToolRenderers);
  assert.ok(resolved?.renderCall);
  assert.notEqual(resolved.renderCall, nativeDefinition.renderCall);
  assert.equal(resolved.renderResult, nativeDefinition.renderResult);

  const row = new ToolExecutionComponent(
    "bash", "runner-row", { command: "echo runner" }, {}, resolved as never, { requestRender: () => {} } as never, cwd,
  );
  render(row);
  store.set(status("runner-row"));
  assert.match(render(row).join("\n"), /native parity/);
  const nativeRow = new ToolExecutionComponent(
    "bash", "runner-native", { command: "echo runner" }, {}, nativeDefinition, { requestRender: () => {} } as never, cwd,
  );
  assert.deepEqual(withoutStatus(render(row), status("runner-row")), render(nativeRow));
});

test("uses public native Bash renderers and preserves the native backend identity", () => {
  const renderer: { current?: ToolRendererResolver } = {};
  const api = createApi(renderer);
  const display = createReviewDisplay(api, VERSION, [...VERIFIED_PI_VERSIONS, VERSION]);
  const ctx = context();

  const precreated = new ToolExecutionComponent(
    "bash", "precreated", { command: "echo precreated" }, {}, nativeDefinition, { requestRender: () => {} } as never, cwd,
  );
  display.show(ctx, toolRowUi, status("precreated", { label: "precreated" }), "precreated-widget");
  assert.equal(typeof renderer.current, "function");
  let delegated = 0;
  const wrapped = renderer.current!("bash", () => {
    delegated++;
    return nativeDefinition as unknown as ToolRenderers;
  })!;
  const later = new ToolExecutionComponent(
    "bash", "later", { command: "echo later" }, {}, wrapped, { requestRender: () => {} } as never, cwd,
  );
  assert.equal(delegated, 1);
  display.show(ctx, toolRowUi, status("later"), "later-widget");
  assert.match(render(later).join("\n"), /guardian running · native parity/);

  assert.match(render(precreated).join("\n"), /\$ echo precreated/);
  assert.match(render(later).join("\n"), /\$ echo later/);
  assert.equal(nativeDefinition.execute, nativeExecute);
  exerciseResult(later);
  const nativeLater = new ToolExecutionComponent(
    "bash", "native-later", { command: "echo later" }, {}, nativeDefinition, { requestRender: () => {} } as never, cwd,
  );
  exerciseResult(nativeLater);
  assert.deepEqual(withoutStatus(render(later), status("later")), render(nativeLater));
  assert.match(render(later).join("\n"), /short output/);
});

test("matches native call and result rendering after removing only the inserted status line", () => {
  const store = createRowStore();
  const wrapped = {
    ...nativeDefinition,
    renderCall: wrapNative(nativeDefinition.renderCall! as unknown as NonNullable<ToolRenderers["renderCall"]>, store),
  } as unknown as ToolRenderers;
  const running = status("row");
  store.set(running);
  const native = new ToolExecutionComponent(
    "bash", "native", { command: "echo parity" }, {}, nativeDefinition, { requestRender: () => {} } as never, cwd,
  );
  const row = new ToolExecutionComponent(
    "bash", "row", { command: "echo parity" }, {}, wrapped, { requestRender: () => {} } as never, cwd,
  );
  native.updateArgs({ command: "echo parity" });
  row.updateArgs({ command: "echo parity" });

  assert.deepEqual(withoutStatus(render(row), running), render(native));
  assert.equal(wrapped.renderResult, nativeDefinition.renderResult);
  exerciseResult(native);
  exerciseResult(row);
  assert.deepEqual(withoutStatus(render(row), running), render(native));
  assert.match(render(native).join("\n"), /short output/);
  assert.match(render(row).join("\n"), /short output/);
});

test("raw native parity preserves ANSI and blank lines across argument and status variants", () => {
  const variants: Array<{ state: ReviewStatus["state"]; command: string; expanded: boolean; error: boolean }> = [
    { state: "guardian-running", command: "echo", expanded: true, error: false },
    { state: "approval-required", command: "echo partial", expanded: true, error: false },
    { state: "approved", command: "echo complete", expanded: true, error: false },
    { state: "revision-requested", command: "printf 'one\\ntwo'", expanded: false, error: false },
    { state: "blocked", command: "false", expanded: true, error: true },
  ];
  for (const [index, variant] of variants.entries()) {
    const store = createRowStore();
    const status = statusForVariant(`raw-${index}`, variant.state);
    const wrapped = {
      ...nativeDefinition,
      renderCall: wrapNative(nativeDefinition.renderCall! as unknown as NonNullable<ToolRenderers["renderCall"]>, store),
    } as unknown as ToolRenderers;
    const native = new ToolExecutionComponent(
      "bash", `native-${index}`, { command: "echo" }, {}, nativeDefinition, { requestRender: () => {} } as never, cwd,
    );
    const row = new ToolExecutionComponent(
      "bash", `raw-${index}`, { command: "echo" }, {}, wrapped, { requestRender: () => {} } as never, cwd,
    );
    render(native);
    render(row);
    store.set(status);
    native.updateArgs({ command: variant.command });
    row.updateArgs({ command: variant.command });
    native.setExpanded(variant.expanded);
    row.setExpanded(variant.expanded);
    assert.deepEqual(withoutStatus(render(row), status), render(native), `${variant.state} call render`);
    native.markExecutionStarted();
    row.markExecutionStarted();
    const output = variant.error ? "error output\n".repeat(6) : "sample output\n";
    const streaming = { content: [{ type: "text", text: "streaming line\n" }], isError: variant.error };
    native.updateResult(streaming, true);
    row.updateResult(streaming, true);
    assert.deepEqual(withoutStatus(render(row), status), render(native), `${variant.state} streaming render`);
    native.updateResult({ content: [{ type: "text", text: output }], isError: variant.error }, true);
    row.updateResult({ content: [{ type: "text", text: output }], isError: variant.error }, true);
    native.updateResult({ content: [{ type: "text", text: output }], isError: variant.error, durationMs: 2345 });
    row.updateResult({ content: [{ type: "text", text: output }], isError: variant.error, durationMs: 2345 });
    assert.deepEqual(withoutStatus(render(row), status), render(native), `${variant.state} completed render`);
  }
});

function statusForVariant(toolCallId: string, state: ReviewStatus["state"]): ReviewStatus {
  return { toolCallId, state, label: "raw parity" };
}

test("attributes synchronous cancellation once and isolates reset from late row dependencies", () => {
  const store = createRowStore();
  const wrapped = {
    ...nativeDefinition,
    renderCall: wrapNative(nativeDefinition.renderCall! as unknown as NonNullable<ToolRenderers["renderCall"]>, store),
  } as unknown as ToolRenderers;
  const row = new ToolExecutionComponent(
    "bash", "cancelled-row", { command: "echo cancelled" }, {}, wrapped, { requestRender: () => {} } as never, cwd,
  );

  render(row);
  store.set(status("cancelled-row", { state: "blocked", detail: "Cancelled" }));
  const cancelledLines = render(row).filter((line) => line.includes("Cancelled"));
  assert.equal(cancelledLines.length, 1);

  store.clear();
  store.set(status("cancelled-row", { state: "approved", detail: "late" }));
  assert.equal(render(row).some((line) => line.includes("late")), false);
});

test("supports partial arguments, terminal status, long output, errors and duration without leaking timers", () => {
  const renderer: { current?: ToolRendererResolver } = {};
  const api = createApi(renderer);
  const display = createReviewDisplay(api, VERSION, [...VERIFIED_PI_VERSIONS, VERSION]);
  const ctx = context();
  const seed = new ToolExecutionComponent(
    "bash", "seed-2", { command: "echo seed" }, {}, nativeDefinition, { requestRender: () => {} } as never, cwd,
  );
  display.show(ctx, toolRowUi, status("seed-2", { label: "seed" }), "seed-widget");
  const wrapped = resolveWrapped(renderer.current!);
  const row = new ToolExecutionComponent(
    "bash", "variants", { command: "echo" }, {}, wrapped, { requestRender: () => {} } as never, cwd,
  );
  render(row);
  display.show(ctx, toolRowUi, status("variants", { state: "approval-required", label: "variant" }), "variants-widget");
  row.updateArgs({ command: "echo partial output" });
  assert.match(render(row).join("\n"), /echo partial output/);
  row.setExpanded(false);
  row.markExecutionStarted();
  row.updateResult({ content: [{ type: "text", text: "long output\n".repeat(20) }], isError: true }, true);
  assert.match(render(row).join("\n"), /long output/);
  row.updateResult({ content: [{ type: "text", text: "long output\n".repeat(20) }], isError: true, durationMs: 9876 });
  row.setExpanded(true);
  assert.match(render(row).join("\n"), /Took 9\.9s/);
  const nativeVariant = new ToolExecutionComponent(
    "bash", "native-variants", { command: "echo" }, {}, nativeDefinition, { requestRender: () => {} } as never, cwd,
  );
  nativeVariant.updateArgs({ command: "echo partial output" });
  nativeVariant.setExpanded(false);
  nativeVariant.markExecutionStarted();
  nativeVariant.updateResult({ content: [{ type: "text", text: "long output\n".repeat(20) }], isError: true }, true);
  nativeVariant.updateResult({ content: [{ type: "text", text: "long output\n".repeat(20) }], isError: true, durationMs: 9876 });
  nativeVariant.setExpanded(true);
  assert.deepEqual(withoutStatus(render(row), status("variants", { state: "approval-required", label: "variant" })), render(nativeVariant));
  display.dropInvalidator("variants");
});

test("actual ready row stays cancelled across late confirmation and session reset/shutdown", async (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), "auto-approval-late-row-"));
  const agentDir = join(root, "global");
  const home = join(root, "home");
  const globalDir = join(home, ".pi", "pi-auto-approval");
  mkdirSync(agentDir);
  mkdirSync(globalDir, { recursive: true });
  writeFileSync(join(globalDir, "auto-permissions.json"), JSON.stringify({
    enabled: true,
    reviewMode: "manual",
    permissions: { allow: ["Bash(seed)"], ask: ["Bash(danger)"] },
    ui: { status: true, placement: "toolRow" },
  }));
  const previousHome = process.env.HOME;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });

  const handlers = new Map<string, (...args: any[]) => unknown>();
  let permissionCommand: ((args: string, ctx: ExtensionContext) => unknown) | undefined;
  let resolver: ToolRendererResolver | undefined;
  const pi = {
    on: (name: string, handler: (...args: any[]) => unknown) => { handlers.set(name, handler); return () => {}; },
    registerCommand: (_name: string, options: { handler: (args: string, ctx: ExtensionContext) => unknown }) => { permissionCommand = options.handler; },
    getAllTools: () => [{ name: "bash", sourceInfo: { source: "builtin", path: "builtin:bash" } }],
    registerToolRenderer: (value: ToolRendererResolver) => { resolver = value; },
  } as unknown as ExtensionAPI;
  autoApproval(pi, [VERSION]);
  let resolveConfirm!: (approved: boolean) => void;
  let confirmStarted!: () => void;
  const opened = new Promise<void>((resolve) => { confirmStarted = resolve; });
  let confirms = 0;
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: root,
    signal: undefined,
    isProjectTrusted: () => true,
    ui: {
      confirm: () => {
        confirms++;
        confirmStarted();
        return new Promise<boolean>((resolve) => { resolveConfirm = resolve; });
      },
      setWidget: () => {},
      setStatus: () => {},
      select: async () => "Protection off",
      notify: () => {},
    },
  } as unknown as ExtensionContext;
  const toolCall = handlers.get("tool_call")! as (event: ToolCallEvent, ctx: ExtensionContext) => Promise<unknown>;
  assert.equal(await toolCall({ type: "tool_call", toolName: "bash", toolCallId: "ready-seed", input: { command: "seed" } }, ctx), undefined);
  assert.equal(typeof resolver, "function");
  const extension = {
    path: "/test/auto-approval-late.ts", resolvedPath: "/test/auto-approval-late.ts",
    sourceInfo: { source: "extension", path: "/test/auto-approval-late.ts", scope: "user" as const, origin: "top-level" as const },
    handlers: new Map(), tools: new Map(), messageRenderers: new Map(), toolRenderers: [resolver!],
    commands: new Map(), flags: new Map(), shortcuts: new Map(),
  };
  const runner = new ExtensionRunner([extension], createExtensionRuntime(), cwd, {} as never, {} as never);
  const renderers = runner.resolveToolRenderers("bash", () => nativeDefinition as unknown as ToolRenderers)!;
  const callId = "ready-cancelled";
  const row = new ToolExecutionComponent(
    "bash", callId, { command: "danger" }, {}, renderers as never, { requestRender: () => {} } as never, cwd,
  );
  render(row);
  const pending = toolCall({ type: "tool_call", toolName: "bash", toolCallId: callId, input: { command: "danger" } }, ctx);
  await opened;
  assert.equal(confirms, 1);
  await permissionCommand!("", ctx);
  assert.deepEqual(await pending, { block: true, reason: "auto-approval: confirmation failed" });
  const cancelled = render(row).filter((line) => line.includes("Cancelled"));
  assert.equal(cancelled.length, 1, "the ready row gets one attributed cancellation terminal");
  assert.equal(handlers.has("session_start"), true);
  await handlers.get("session_start")!({ reason: "new" }, ctx);
  assert.equal(render(row).some((line) => line.includes("Cancelled") || line.includes("approved")), false, "reset clears old row status while the prompt is unresolved");
  resolveConfirm(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(render(row).some((line) => line.includes("Cancelled") || line.includes("approved")), false, "late prompt settlement cannot resurrect status after reset");
  handlers.get("session_shutdown")!({}, ctx);
  handlers.get("session_shutdown")!({}, ctx);
  assert.equal(render(row).some((line) => line.includes("approved") || line.includes("Cancelled")), false, "shutdown remains idempotent");
});

test("session reset redraws an ended native row without rebinding it", async (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), "auto-approval-ended-row-"));
  const agentDir = join(root, "global");
  const home = join(root, "home");
  const globalDir = join(home, ".pi", "pi-auto-approval");
  mkdirSync(agentDir);
  mkdirSync(globalDir, { recursive: true });
  writeFileSync(join(globalDir, "auto-permissions.json"), JSON.stringify({
    enabled: true,
    reviewMode: "manual",
    permissions: { allow: ["Bash(safe)"] },
    ui: { status: true, placement: "toolRow" },
  }));
  const previousHome = process.env.HOME;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });

  const handlers = new Map<string, (...args: any[]) => unknown>();
  let resolver: ToolRendererResolver | undefined;
  const pi = {
    on: (name: string, handler: (...args: any[]) => unknown) => { handlers.set(name, handler); return () => {}; },
    registerCommand: () => {},
    getAllTools: () => [{ name: "bash", sourceInfo: { source: "builtin", path: "builtin:bash" } }],
    registerToolRenderer: (value: ToolRendererResolver) => { resolver = value; },
  } as unknown as ExtensionAPI;
  autoApproval(pi, [VERSION]);
  const ctx = {
    mode: "tui", hasUI: true, cwd: root, signal: undefined, isProjectTrusted: () => true,
    ui: { confirm: async () => true, setWidget: () => {}, setStatus: () => {}, notify: () => {} },
  } as unknown as ExtensionContext;
  const toolCall = handlers.get("tool_call")! as (event: ToolCallEvent, ctx: ExtensionContext) => Promise<unknown>;
  const callId = "ended-row";
  await toolCall({ type: "tool_call", toolName: "bash", toolCallId: "seed", input: { command: "safe" } }, ctx);
  const extension = {
    path: "/test/ended-row.ts", resolvedPath: "/test/ended-row.ts",
    sourceInfo: { source: "extension", path: "/test/ended-row.ts", scope: "user" as const, origin: "top-level" as const },
    handlers: new Map(), tools: new Map(), messageRenderers: new Map(), toolRenderers: [resolver!],
    commands: new Map(), flags: new Map(), shortcuts: new Map(),
  };
  const runner = new ExtensionRunner([extension], createExtensionRuntime(), cwd, {} as never, {} as never);
  const renderers = runner.resolveToolRenderers("bash", () => nativeDefinition as unknown as ToolRenderers)!;
  let row!: ToolExecutionComponent;
  row = new ToolExecutionComponent(
    "bash", callId, { command: "safe" }, {}, renderers as never, { requestRender: () => render(row) } as never, cwd,
  );
  render(row);
  await toolCall({ type: "tool_call", toolName: "bash", toolCallId: callId, input: { command: "safe" } }, ctx);
  assert.match(render(row).join("\n"), /approved/);
  handlers.get("tool_execution_end")!({ toolName: "bash", toolCallId: callId }, ctx);
  handlers.get("session_start")!({ reason: "new" }, ctx);
  assert.equal(render(row).some((line) => line.includes("approved")), false);
  await toolCall({ type: "tool_call", toolName: "bash", toolCallId: callId, input: { command: "safe" } }, ctx);
  assert.equal(render(row).some((line) => line.includes("approved")), false, `an old row cannot rebind after reset: ${render(row).join(" | ")}`);
});

test("actual extension factory routes a ready native row through Pi's resolver chain", async (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), "auto-approval-connected-row-"));
  const agentDir = join(root, "global");
  const home = join(root, "home");
  const globalDir = join(home, ".pi", "pi-auto-approval");
  mkdirSync(agentDir);
  mkdirSync(globalDir, { recursive: true });
  writeFileSync(join(globalDir, "auto-permissions.json"), JSON.stringify({
    enabled: true,
    reviewMode: "manual",
    permissions: {},
    ui: { status: true, placement: "toolRow" },
  }));
  const previousHome = process.env.HOME;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });

  const handlers = new Map<string, (...args: any[]) => unknown>();
  let resolver: ToolRendererResolver | undefined;
  const pi = {
    on: (name: string, handler: (...args: any[]) => unknown) => { handlers.set(name, handler); return () => {}; },
    registerCommand: () => {},
    getAllTools: () => [{ name: "bash", sourceInfo: { source: "builtin", path: "builtin:bash" } }],
    registerToolRenderer: (value: ToolRendererResolver) => { resolver = value; },
  } as unknown as ExtensionAPI;
  autoApproval(pi, [VERSION]);
  const confirmations: unknown[][] = [];
  const widgets: unknown[] = [];
  const controller = new AbortController();
  let cancelOnRedraw = false;
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: root,
    signal: controller.signal,
    isProjectTrusted: () => true,
    ui: {
      confirm: async (...args: unknown[]) => { confirmations.push(args); return true; },
      setWidget: (...args: unknown[]) => widgets.push(args),
      setStatus: () => {},
      notify: () => {},
    },
  } as unknown as ExtensionContext;
  await handlers.get("tool_call")!({ type: "tool_call", toolName: "bash", toolCallId: "factory-registration-call", input: { command: "echo registration" } }, ctx);
  assert.equal(typeof resolver, "function");
  const fallbackCount = widgets.length;

  const extension = {
    path: "/test/auto-approval.ts",
    resolvedPath: "/test/auto-approval.ts",
    sourceInfo: { source: "extension", path: "/test/auto-approval.ts", scope: "user" as const, origin: "top-level" as const },
    handlers: new Map(),
    tools: new Map(),
    messageRenderers: new Map(),
    toolRenderers: [resolver!],
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
  const runner = new ExtensionRunner([extension], createExtensionRuntime(), cwd, {} as never, {} as never);
  const connectedRenderers = runner.resolveToolRenderers("bash", () => nativeDefinition as unknown as ToolRenderers)!;
  const toolCallId = "factory-connected-row";
  const row = new ToolExecutionComponent(
    "bash", toolCallId, { command: "echo connected" }, {}, connectedRenderers as never,
    { requestRender: () => { if (cancelOnRedraw && confirmations.length > 1) controller.abort(); } } as never, cwd,
  );
  render(row);
  cancelOnRedraw = true;
  const outcome = await handlers.get("tool_call")!({ type: "tool_call", toolName: "bash", toolCallId, input: { command: "echo connected" } }, ctx);
  assert.deepEqual(outcome, { block: true, reason: "auto-approval: confirmation failed" });
  assert.equal(confirmations.length, 2);
  assert.equal(widgets.length, fallbackCount, "the ready call does not fall back to a widget");
  const visible = render(row).join("\n");
  assert.match(visible, /✗ blocked · Unmatched Bash command/);
  assert.equal(visible.match(/Cancelled/g)?.length, 1);
  assert.equal(nativeDefinition.execute, nativeExecute);
});
