import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
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

export const nativeBash = createBashToolDefinition(process.cwd());
export const nativeExecute = nativeBash.execute;

export const REVIEW_REASON = "ok";
export function reviewerReply(decision: "approve" | "revise", reason = REVIEW_REASON) {
  return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ decision, reason }) }], usage: { input: 20, cacheRead: 0, cacheWrite: 0 } };
}

export interface HarnessOptions {
  readonly reviewMode: "manual" | "auto";
  readonly placement?: "widget" | "toolRow";
  readonly rules?: readonly Record<string, unknown>[];
  readonly confirm?: (...args: unknown[]) => Promise<boolean>;
  readonly provider?: (call: number) => Promise<unknown>;
}

export interface Harness {
  readonly ctx: ExtensionContext;
  readonly widgets: unknown[][];
  readonly confirmations: unknown[][];
  readonly providerRequests: unknown[];
  readonly controller: AbortController;
  call(command: string, toolCallId: string): Promise<unknown>;
  row(command: string, toolCallId: string): { row: ToolExecutionComponent; frames: string[]; renderers: ToolRenderers };
  nativeRow(command: string, toolCallId: string): ToolExecutionComponent;
  sessionStart(): Promise<unknown> | unknown;
  shutdown(): unknown;
}

const PADDING = /^\u001b\[[0-9;]*m *\u001b\[[0-9;]*m$/;

export async function createHarness(t: TestContext, options: HarnessOptions): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "auto-approval-factory-"));
  const agentDir = join(root, "global");
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "auto-permissions.json"), JSON.stringify({
    enabled: true,
    reviewMode: options.reviewMode,
    rules: [{ pattern: "^seed$", level: "allow", label: "seed" }, ...(options.rules ?? [])],
    ui: { status: true, placement: options.placement ?? "toolRow" },
  }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });

  const handlers = new Map<string, (...args: any[]) => unknown>();
  let resolver: ToolRendererResolver | undefined;
  const widgets: unknown[][] = [];
  const confirmations: unknown[][] = [];
  const providerRequests: unknown[] = [];
  const controller = new AbortController();
  const pi = {
    on: (name: string, handler: (...args: any[]) => unknown) => { handlers.set(name, handler); return () => {}; },
    registerCommand: () => {},
    getAllTools: () => [{ name: "bash", sourceInfo: { source: "builtin", path: "builtin:bash" } }],
    registerToolRenderer: (value: ToolRendererResolver) => { resolver = value; },
  } as unknown as ExtensionAPI;
  autoApproval(pi, [VERSION]);
  const model = { provider: "mock", id: "reviewer", api: "mock", baseUrl: "", contextWindow: 128_000 };
  const ctx = {
    mode: "tui", hasUI: true, cwd: root, signal: controller.signal, model,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "factory-session", buildSessionProjection: () => ({ entries: [] }) },
    modelRegistry: {
      find: () => undefined,
      streamSimple: (_model: unknown, prompt: unknown, streamOptions: unknown) => {
        providerRequests.push({ prompt: structuredClone(prompt), options: streamOptions });
        const call = providerRequests.length;
        return { result: async () => (options.provider ? options.provider(call) : reviewerReply("approve")) };
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

  const toolCall = handlers.get("tool_call") as (event: ToolCallEvent, context: ExtensionContext) => Promise<unknown>;
  const resolve = (renderTarget: string) => {
    assert.ok(resolver, "the actual factory registers the public renderer resolver");
    const extension = {
      path: `/test/${renderTarget}.ts`, resolvedPath: `/test/${renderTarget}.ts`,
      sourceInfo: { source: "extension", path: `/test/${renderTarget}.ts`, scope: "user" as const, origin: "top-level" as const },
      handlers: new Map(), tools: new Map(), messageRenderers: new Map(), toolRenderers: [resolver],
      commands: new Map(), flags: new Map(), shortcuts: new Map(),
    };
    const runner = new ExtensionRunner([extension], createExtensionRuntime(), root, {} as never, {} as never);
    return runner.resolveToolRenderers("bash", () => nativeBash as unknown as ToolRenderers)!;
  };
  if (options.placement !== "widget") {
    assert.equal(await toolCall({ type: "tool_call", toolName: "bash", toolCallId: "harness-seed", input: { command: "seed" } }, ctx), undefined);
    assert.ok(resolver);
    widgets.length = 0;
    providerRequests.length = 0;
    confirmations.length = 0;
  }
  return {
    ctx,
    widgets,
    confirmations,
    providerRequests,
    controller,
    call: (command, toolCallId) => toolCall({ type: "tool_call", toolName: "bash", toolCallId, input: { command } }, ctx),
    row(command, toolCallId) {
      const frames: string[] = [];
      const renderers = resolve(toolCallId);
      let row!: ToolExecutionComponent;
      row = new ToolExecutionComponent("bash", toolCallId, { command }, {}, renderers as never, {
        requestRender: () => { if (row) frames.push(row.render(100).join("\n")); },
      } as never, root);
      row.render(100);
      return { row, frames, renderers };
    },
    nativeRow: (command, toolCallId) => new ToolExecutionComponent("bash", toolCallId, { command }, {}, nativeBash as never, { requestRender: () => {} } as never, root),
    sessionStart: () => handlers.get("session_start")!({ reason: "new" }, ctx),
    shutdown: () => handlers.get("session_shutdown")!({}, ctx),
  };
}

export function plain(lines: string[]): string[] {
  return lines.map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").trim());
}

// Removes exactly the expected inserted status block and the known padding pair, and proves they are present.
export function withoutInsertedStatus(lines: string[], expected: string[]): string[] {
  const start = lines.findIndex((_line, index) => expected.every((text, offset) => plain([lines[index + offset] ?? ""])[0] === text));
  assert.notEqual(start, -1, `expected exact inserted status lines ${JSON.stringify(expected)} in ${JSON.stringify(lines)}`);
  let end = start + expected.length;
  const padding = lines[end];
  if (padding && PADDING.test(padding)) {
    assert.equal(lines[end + 1], padding, "expected only the renderer's paired status-container padding");
    end += 2;
  }
  return [...lines.slice(0, start), ...lines.slice(end)];
}

export function transitions(states: Array<string | undefined>): string[] {
  const observed = states.filter((state): state is string => state !== undefined);
  return observed.filter((state, index) => index === 0 || state !== observed[index - 1]);
}

const ROW_STATES = ["guardian running", "approval required", "revision requested", "approved", "blocked"];
export function rowState(frame: string): string | undefined {
  const state = ROW_STATES.find((candidate) => frame.includes(candidate));
  return state && frame.includes("Cancelled") ? `${state} + Cancelled` : state;
}
