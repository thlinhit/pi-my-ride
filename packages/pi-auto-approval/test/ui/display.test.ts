import assert from "node:assert/strict";
import test, { mock } from "node:test";

const resetTimers = () => mock.timers.reset();
import { createReviewDisplay } from "../../src/ui/display.ts";
import type { ConfigUi } from "../../src/config.ts";
import type { ExtensionAPI, ExtensionContext, ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import type { ReviewStatus } from "../../src/ui/status.ts";

const ui: ConfigUi = { status: true, placement: "toolRow" };
const status: ReviewStatus = { toolCallId: "call-1", state: "approved", label: "safe" };


function context(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  const widgets: unknown[] = [];
  return {
    mode: "tui",
    hasUI: true,
    cwd: ".",
    ui: {
      setWidget: (...args: unknown[]) => widgets.push(args),
      notify: () => {},
    } as unknown as ExtensionContext["ui"],
    ...overrides,
  } as ExtensionContext;
}

function api(overrides: Partial<ExtensionAPI> = {}): ExtensionAPI {
  let renderer: unknown;
  return {
    getAllTools: () => [{ name: "bash", sourceInfo: { source: "builtin" } }],
    registerToolRenderer: (resolver: ToolRendererResolver) => { renderer = resolver; },
    ...overrides,
    __renderer: () => renderer,
  } as unknown as ExtensionAPI & { __renderer(): unknown };
}

test("registers a renderer for verified builtin Bash using next()", () => {
  let resolver: ToolRendererResolver | undefined;
  const extension = api({ registerToolRenderer: (value) => { resolver = value; } });
  const display = createReviewDisplay(extension, "1.1.0", ["1.1.0"]);
  display.show(context(), ui, { ...status, state: "guardian-running" }, "key");

  let delegated = 0;
  const native = { renderCall: () => "native", renderResult: () => "result" } as never;
  const resolved = resolver!("bash", () => { delegated++; return native; });
  assert.equal(delegated, 1);
  assert.notEqual(resolved?.renderCall, (native as { renderCall: unknown }).renderCall);
  assert.equal(resolved?.renderResult, (native as { renderResult: unknown }).renderResult);
});

test("keeps unverified row support on the widget path", () => {
  const notifications: string[] = [];
  const ctx = context({ ui: { ...context().ui, notify: (message: string) => notifications.push(message) } as unknown as ExtensionContext["ui"] });
  const widgets: unknown[] = [];
  ctx.ui.setWidget = (...args: unknown[]) => widgets.push(args);
  const display = createReviewDisplay(api(), "1.1.0", []);
  display.show(ctx, ui, status, "auto-approval:1");

  assert.equal(widgets.length, 1);
  assert.equal(notifications.length, 1);
});

test("keeps RPC widget reports visible without registering a row renderer", () => {
  let registrations = 0;
  const widgets: unknown[] = [];
  const extension = api({ registerToolRenderer: () => { registrations++; } });
  const ctx = context({ mode: "rpc" });
  ctx.ui.setWidget = (...args: unknown[]) => widgets.push(args);
  const display = createReviewDisplay(extension, "1.1.0", ["1.1.0"]);
  display.show(ctx, { status: true, placement: "toolRow" }, status, "key");
  assert.equal(registrations, 0);
  assert.deepEqual((widgets[0] as unknown[])[1], ["auto-approval: approved [safe]"]);
});

test("does not register when status is hidden", () => {
  let registrations = 0;
  const extension = api({ registerToolRenderer: () => { registrations++; } });
  const display = createReviewDisplay(extension, "1.1.0", ["1.1.0"]);
  display.show(context(), { status: false, placement: "toolRow" }, status, "key");
  assert.equal(registrations, 0);
});

test("rejects non-builtin backends and changed builtin attribution", () => {
  let registrations = 0;
  const builtinSourceInfo = { source: "builtin", path: "builtin:bash", scope: "user", origin: "top-level" };
  let tools: unknown[] = [{ name: "bash", sourceInfo: builtinSourceInfo }];
  const extension = api({
    getAllTools: () => tools as never,
    registerToolRenderer: () => { registrations++; },
  });
  const notifications: string[] = [];
  const ctx = context({ ui: { ...context().ui, notify: (message: string) => notifications.push(message) } as unknown as ExtensionContext["ui"] });
  const display = createReviewDisplay(extension, "1.1.0", ["1.1.0"]);
  display.show(ctx, ui, { ...status, toolCallId: "call-1" }, "key-1");
  tools = [{ name: "bash", sourceInfo: builtinSourceInfo }];
  display.show(ctx, ui, { ...status, toolCallId: "call-2" }, "key-2");
  tools = [{ name: "bash", sourceInfo: { source: "extension", path: "extension:bash", scope: "project", origin: "top-level" } }];
  display.show(ctx, ui, { ...status, toolCallId: "call-3" }, "key-3");
  assert.equal(registrations, 1);
  assert.equal(notifications.length, 1);
});

test("retains terminal route and clears widget state on shutdown", () => {
  const widgets: unknown[] = [];
  const ctx = context();
  ctx.ui.setWidget = (...args: unknown[]) => widgets.push(args);
  const display = createReviewDisplay(api(), "1.1.0", []);
  display.show(ctx, { status: true, placement: "widget" }, status, "key");
  display.shutdown(ctx);
  assert.deepEqual(widgets.map((entry) => (entry as unknown[])[1]), [["auto-approval: approved [safe]"], undefined]);
});

test("reset cancels obsolete widget timers and generation callbacks", () => {
  resetTimers();
  mock.timers.enable({ apis: ["setTimeout"] });
  const widgets: unknown[] = [];
  const ctx = context();
  ctx.ui.setWidget = (...args: unknown[]) => widgets.push(args);
  const display = createReviewDisplay(api(), "1.1.0", []);
  display.show(ctx, { status: true, placement: "widget" }, { ...status, state: "approved" }, "key");
  const oldGeneration = display.generation();
  display.reset(ctx);
  display.show(ctx, { status: true, placement: "widget" }, { ...status, state: "approval-required" }, "key", oldGeneration);
  mock.timers.tick(2000);
  assert.deepEqual(widgets.map((entry) => (entry as unknown[])[1]), [
    ["auto-approval: approved [safe]"],
    undefined,
  ]);
  display.show(ctx, { status: true, placement: "widget" }, { ...status, state: "approval-required" }, "key", display.generation());
  mock.timers.tick(2000);
  assert.deepEqual((widgets.at(-1) as unknown[] | undefined)?.[1], ["auto-approval: reviewing [safe]"]);
});

test("widget cleanup still runs when widget publication throws", () => {
  resetTimers();
  mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const ctx = context();
  ctx.ui.setWidget = () => {
    calls++;
    throw new Error("widget failed");
  };
  const display = createReviewDisplay(api(), "1.1.0", []);
  display.show(ctx, { status: true, placement: "widget" }, { ...status, state: "approved" }, "key");
  mock.timers.tick(2000);
  assert.equal(calls, 2);
});
