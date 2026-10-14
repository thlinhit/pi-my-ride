import assert from "node:assert/strict";
import test from "node:test";
import { Container, Text } from "@earendil-works/pi-tui";
import { createRowStore, wrapNative } from "../../src/ui/rows.ts";
import type { ReviewStatus } from "../../src/ui/status.ts";

const status = (overrides: Partial<ReviewStatus> = {}): ReviewStatus => ({ toolCallId: "call-1", state: "guardian-running", label: "danger command", ...overrides });
const context = (toolCallId = "call-1", invalidate = () => {}): Parameters<ReturnType<typeof wrapNative>>[2] => ({
  cwd: ".", executionStarted: false, args: { command: "echo harmless" }, argsComplete: true, isPartial: true,
  toolCallId, invalidate, lastComponent: undefined, state: {},
} as unknown as Parameters<ReturnType<typeof wrapNative>>[2]);
const theme = {} as Parameters<ReturnType<typeof wrapNative>>[1];
const native = () => new Text("native command");
const lines = (component: { render(width: number): string[] }): string[] => component.render(80).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim()).filter(Boolean);

test("marks a row ready before its first status and redraws on status changes", () => {
  const store = createRowStore(); let invalidations = 0; const wrapped = wrapNative(native, store);
  const first = wrapped({}, theme, context("call-1", () => invalidations++));
  assert.deepEqual(lines(first), ["native command"]); assert.equal(store.isReady("call-1"), true);
  store.set(status()); assert.equal(invalidations, 1);
  assert.deepEqual(lines(wrapped({}, theme, context("call-1", () => invalidations++))), ["native command", "◌ guardian running · danger command"]);
  store.set(status({ state: "approved" })); assert.equal(invalidations, 2);
  assert.deepEqual(lines(wrapped({}, theme, context("call-1", () => invalidations++))), ["native command", "✓ approved · danger command"]);
  store.set(status({ state: "blocked" })); assert.equal(invalidations, 3);
});

test("redraws a terminal status published during an in-flight invalidation", () => {
  const store = createRowStore(); let invalidations = 0;
  const wrapped = wrapNative(native, store);
  wrapped({}, theme, context("call-1", () => {
    invalidations++;
    if (invalidations === 1) store.set(status({ state: "blocked", detail: "Cancelled" }));
  }));

  store.set(status({ state: "approved" }));

  assert.equal(invalidations, 2);
  assert.deepEqual(lines(wrapped({}, theme, context())), ["native command", "✗ blocked · danger command", "Cancelled"]);
  store.set(status({ state: "blocked", detail: "Cancelled" }));
  assert.equal(invalidations, 3);
});

test("reuses native lastComponent and keeps rows independent", () => {
  const store = createRowStore(); const seen: unknown[] = [];
  const wrapped = wrapNative((_args, _theme, ctx) => { seen.push(ctx.lastComponent); return new Text("native"); }, store);
  const first = wrapped({}, theme, context()); store.set(status());
  const second = wrapped({}, theme, { ...context(), lastComponent: first }); wrapped({}, theme, context("call-2"));
  assert.equal(seen[0], undefined); assert.equal(seen[1], first); assert.equal(store.isReady("call-2"), true); assert.ok(second instanceof Container);
});

test("clear advances generation and redraws without rebinding old wrappers", () => {
  const store = createRowStore(); let invalidations = 0; const wrapped = wrapNative(native, store);
  wrapped({}, theme, context("call-1", () => invalidations++)); store.set(status({ state: "approved" })); store.clear();
  assert.equal(invalidations, 2, "clear redraws a rendered terminal row"); assert.equal(store.isReady("call-1"), false);
  wrapped({}, theme, context()); assert.equal(store.isReady("call-1"), false);
});
