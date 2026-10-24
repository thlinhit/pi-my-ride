import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import test from "node:test";
import type { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { createHarness, nativeBash, reviewerReply, withoutInsertedStatus } from "./factory-harness.ts";

type State = "guardian-running" | "approval-required" | "revision-approved" | "approved" | "blocked" | "blocked-cancelled";

const EXPECTED: Record<State, string[]> = {
  "guardian-running": ["◌ guardian running · Unmatched Bash command · mock/reviewer"],
  "approval-required": ["? approval required · Unmatched Bash command"],
  "revision-approved": ["✓ approved · Unmatched Bash command"],
  approved: ["✓ approved · Unmatched Bash command"],
  blocked: ["✗ blocked · Unmatched Bash command"],
  "blocked-cancelled": ["✗ blocked · Unmatched Bash command", "Cancelled"],
};

const COMMAND = "echo";
const FINAL_COMMAND = "echo partial output";

interface Run {
  readonly row: ToolExecutionComponent;
  readonly native: ToolExecutionComponent;
  readonly settle: () => Promise<unknown>;
}

// Each permission state is produced by the actual factory through its real dialog, reviewer, or cancellation path.
async function reachState(t: TestContext, state: State, id: string): Promise<Run> {
  const started = deferredSignal();
  let finish: (value: any) => void = () => {};
  const pendingValue = <T>() => new Promise<T>((resolve) => { finish = resolve; });
  let harness;
  let pending: Promise<unknown> | undefined;
  if (state === "guardian-running") {
    harness = await createHarness(t, { reviewMode: "auto", provider: () => { started.signal(); return pendingValue(); } });
  } else if (state === "revision-approved") {
    harness = await createHarness(t, { reviewMode: "auto", provider: async () => reviewerReply("revise", "change target") });
  } else if (state === "approved") {
    harness = await createHarness(t, { reviewMode: "manual", confirm: async () => true });
  } else if (state === "blocked") {
    harness = await createHarness(t, { reviewMode: "manual", confirm: async () => false });
  } else {
    harness = await createHarness(t, { reviewMode: "manual", confirm: () => { started.signal(); return pendingValue(); } });
  }
  const { row } = harness.row(COMMAND, id);
  const native = harness.nativeRow(COMMAND, `${id}-native`);
  native.render(100);
  if (state === "guardian-running" || state === "approval-required" || state === "blocked-cancelled") {
    pending = harness.call(COMMAND, id);
    await started.reached;
    if (state === "blocked-cancelled") {
      harness.controller.abort();
      await pending;
      pending = undefined;
    }
  } else {
    await harness.call(COMMAND, id);
  }
  return {
    row,
    native,
    settle: async () => {
      if (state === "guardian-running") finish(reviewerReply("approve"));
      else if (state === "approval-required") finish(true);
      else if (state === "blocked-cancelled") finish(false);
      return pending;
    },
  };
}

function deferredSignal() {
  let signal!: () => void;
  const reached = new Promise<void>((resolve) => { signal = resolve; });
  return { reached, signal: () => signal() };
}

function stagesFor(error: boolean) {
  const success = [
    ["partial arguments", (c: ToolExecutionComponent) => c.updateArgs({ command: "echo" })],
    ["complete arguments", (c: ToolExecutionComponent) => { c.updateArgs({ command: FINAL_COMMAND }); c.setArgsComplete(); }],
    ["streaming result", (c: ToolExecutionComponent) => { c.markExecutionStarted(); c.updateResult({ content: [{ type: "text", text: "streaming line\n" }], isError: false }, true); }],
    ["final result", (c: ToolExecutionComponent) => c.updateResult({ content: [{ type: "text", text: "short output" }], isError: false, durationMs: 1234 })],
    ["collapsed", (c: ToolExecutionComponent) => c.setExpanded(false)],
    ["expanded", (c: ToolExecutionComponent) => c.setExpanded(true)],
  ] as const;
  const failing = [
    ["partial arguments", (c: ToolExecutionComponent) => c.updateArgs({ command: "echo" })],
    ["complete arguments", (c: ToolExecutionComponent) => { c.updateArgs({ command: FINAL_COMMAND }); c.setArgsComplete(); }],
    ["collapsed error", (c: ToolExecutionComponent) => c.setExpanded(false)],
    ["streaming error", (c: ToolExecutionComponent) => { c.markExecutionStarted(); c.updateResult({ content: [{ type: "text", text: "error output\n".repeat(8) }], isError: true }, true); }],
    ["final error with duration", (c: ToolExecutionComponent) => c.updateResult({ content: [{ type: "text", text: "error output\n".repeat(8) }], isError: true, durationMs: 9876 })],
    ["expanded error", (c: ToolExecutionComponent) => c.setExpanded(true)],
  ] as const;
  return error ? failing : success;
}

for (const state of Object.keys(EXPECTED) as State[]) {
  for (const error of [false, true]) {
    test(`factory-connected ${state} row matches native through ${error ? "error and duration" : "success"} stages`, async (t) => {
      const run = await reachState(t, state, `native-${state}-${error ? "err" : "ok"}`);
      const { row, native } = run;
      const expected = EXPECTED[state];
      const assertParity = (label: string) => {
        assert.deepEqual(withoutInsertedStatus(row.render(100), expected), native.render(100), `${state} ${label}`);
      };
      assertParity("initial call render");
      for (const [name, apply] of stagesFor(error)) {
        apply(native);
        apply(row);
        assertParity(name);
      }
      const finalNative = native.render(100).join("\n");
      if (error) assert.match(finalNative, /Took 9\.9s/, "error duration renders on the native expanded row");
      if (error) assert.equal(row.render(100).some((line) => line.includes("error output")), true, "error output stays visible");
      await run.settle();
    });
  }
}

test("the factory-connected row keeps the native result renderer and shows only the approved status line", async (t: TestContext) => {
  const harness = await createHarness(t, { reviewMode: "manual", confirm: async () => true });
  const { row, renderers } = harness.row("echo renderer", "identity");
  assert.notEqual(renderers.renderCall, nativeBash.renderCall, "the call slot is decorated");
  assert.equal(renderers.renderResult, nativeBash.renderResult, "the result slot is the untouched native renderer");
  assert.equal(await harness.call("echo renderer", "identity"), undefined);
  assert.deepEqual(withoutInsertedStatus(row.render(100), EXPECTED.approved), harness.nativeRow("echo renderer", "identity-native").render(100));
});
