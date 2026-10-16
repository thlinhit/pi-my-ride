import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import test, { mock } from "node:test";
import { createHarness, plain, reviewerReply, rowState, transitions } from "./factory-harness.ts";

const CANCELLED = { block: true, reason: "auto-approval: confirmation failed" };
const COMMAND = "danger; echo harmless";
const flush = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); await new Promise<void>((resolve) => setImmediate(resolve)); };

function widgetState(item: unknown[]): string | undefined {
  const text = Array.isArray(item[1]) ? item[1].join("\n") : "";
  const state = ["reviewing", "approved", "blocked"].find((candidate) => text.includes(`auto-approval: ${candidate}`));
  return state && text.includes("Cancelled") ? `${state} + Cancelled` : state;
}

function liveWidgetStates(widgets: unknown[][], key: unknown): string[] {
  return transitions(widgets.filter((item) => item[0] === key).map(widgetState));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reached!: () => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  const enter = new Promise<void>((done) => { reached = done; });
  return { promise, resolve, enter, arrive: () => reached() };
}

// Reviewer held open: reset or shutdown while unresolved, then the old approval settles late.
for (const reset of ["session_start", "session_shutdown"] as const) {
  test(`L-1 ${reset} while reviewer is unresolved: late approval cannot publish, prompt, or re-review`, async (t: TestContext) => {
    const gate = deferred<unknown>();
    let providerCalls = 0;
    const h = await createHarness(t, { reviewMode: "auto", provider: () => {
      providerCalls++;
      gate.arrive();
      return gate.promise;
    } });
    const { row, frames } = h.row(COMMAND, "l1");
    const pending = h.call(COMMAND, "l1");
    await gate.enter;
    if (reset === "session_start") await h.sessionStart();
    else h.shutdown();
    assert.deepEqual(await pending, CANCELLED);
    const afterCancel = frames.length;
    gate.resolve(reviewerReply("approve", "late"));
    await flush();
    assert.deepEqual(transitions(frames.map(rowState)), ["guardian running", "blocked + Cancelled"], `${reset}: exactly one attributed Cancelled transition`);
    assert.equal(frames.slice(afterCancel).some((frame) => /approved|late/.test(frame)), false, "no late approval publication");
    assert.equal(/approved|late|Cancelled/.test(row.render(100).join("\n")), false, "the reset/shutdown clears the row status");
    assert.equal(providerCalls, 1, "no provider work after the abandoned review");
    assert.equal(h.confirmations.length, 0, "no prompt after the abandoned review");
    assert.deepEqual(h.widgets.filter((item) => Array.isArray(item[1]) && item[1].length > 0), [], "ready-row lifecycle publishes no content-bearing widget fallback (the seed's own pending widget clears with undefined content)");
  });
}

test("L-1w widget placement: reset while reviewer is unresolved publishes exactly one Cancelled transition", async (t: TestContext) => {
  const gate = deferred<unknown>();
  const h = await createHarness(t, { reviewMode: "auto", placement: "widget", provider: () => { gate.arrive(); return gate.promise; } });
  const pending = h.call(COMMAND, "l1w");
  await gate.enter;
  const key = h.widgets[0]?.[0];
  await h.sessionStart();
  assert.deepEqual(await pending, CANCELLED);
  gate.resolve(reviewerReply("approve", "late"));
  await flush();
  assert.deepEqual(liveWidgetStates(h.widgets, key), ["reviewing", "blocked + Cancelled"]);
  assert.equal(h.widgets.some((item) => JSON.stringify(item).includes("late")), false);
});

test("L-3 queued reviewer call performs no provider work after reset cancels the active review", async (t: TestContext) => {
  const gate = deferred<unknown>();
  let providerCalls = 0;
  const h = await createHarness(t, { reviewMode: "auto", provider: () => {
    providerCalls++;
    gate.arrive();
    return gate.promise;
  } });
  const first = h.row(COMMAND, "queue-1");
  const second = h.row(COMMAND, "queue-2");
  const p1 = h.call(COMMAND, "queue-1");
  await gate.enter;
  const p2 = h.call(COMMAND, "queue-2");
  await flush();
  await h.sessionStart();
  assert.deepEqual(await p1, CANCELLED);
  assert.deepEqual(await p2, CANCELLED);
  gate.resolve(reviewerReply("approve", "late"));
  await flush();
  assert.equal(providerCalls, 1, "the queued request cannot reach the provider after cancellation");
  assert.equal(/approved|late/.test(first.row.render(100).join("\n")), false);
  assert.equal(/approved|late/.test(second.row.render(100).join("\n")), false);
  assert.deepEqual(transitions(second.frames.map(rowState)).filter((state) => state.includes("approved")), []);
});

for (const reset of ["session_start", "session_shutdown"] as const) {
  test(`L-4/5 ${reset} while confirmation is unresolved: late approval cannot publish, and the lock releases only on settlement`, async (t: TestContext) => {
    const dialog = deferred<boolean>();
    let prompts = 0;
    const h = await createHarness(t, { reviewMode: "manual", confirm: () => {
      prompts++;
      if (prompts === 1) {
        dialog.arrive();
        return dialog.promise;
      }
      return Promise.resolve(true);
    } });
    const { row, frames } = h.row("unmatched", "c1");
    const pending = h.call("unmatched", "c1");
    await dialog.enter;
    if (reset === "session_start") await h.sessionStart();
    else h.shutdown();
    assert.deepEqual(await pending, CANCELLED);
    const afterCancel = frames.length;
    const competing = h.row("unmatched", "c2");
    const second = await h.call("unmatched", "c2");
    assert.deepEqual(second, { block: true, reason: "Unmatched Bash command requires confirmation (confirmation failed)" }, "lock rejects an overlapping dialog while the first is unresolved");
    assert.equal(prompts, 1, "no second dialog opens while the first is unresolved");
    const widgetsBeforeLate = [...h.widgets];
    dialog.resolve(true);
    await flush();
    assert.deepEqual(h.widgets, widgetsBeforeLate, `${reset}: no widget publication after the old dialog settles`);
    assert.deepEqual(transitions(frames.map(rowState)), ["approval required", "blocked + Cancelled"], `${reset}: exactly one attributed Cancelled transition`);
    assert.equal(frames.slice(afterCancel).some((frame) => /approved/.test(frame)), false, "late approval never publishes");
    assert.equal(/approved|Cancelled/.test(row.render(100).join("\n")), false);
    assert.equal(/approved/.test(competing.row.render(100).join("\n")), false);
    const recovered = await h.call("unmatched", "c3");
    assert.equal(recovered, undefined, "after the original dialog settles, a new call may prompt and approve");
    assert.equal(prompts, 2);
  });
}

test("L-6 abort during the dialog keeps the confirmation lock until the original dialog settles", async (t: TestContext) => {
  const dialog = deferred<boolean>();
  let prompts = 0;
  const h = await createHarness(t, { reviewMode: "manual", confirm: () => {
    prompts++;
    if (prompts === 1) {
      dialog.arrive();
      return dialog.promise;
    }
    return Promise.resolve(true);
  } });
  const first = h.call("unmatched", "lock-1");
  await dialog.enter;
  await h.sessionStart();
  assert.deepEqual(await first, CANCELLED);
  const rejected = await h.call("unmatched", "lock-2");
  assert.deepEqual(rejected, { block: true, reason: "Unmatched Bash command requires confirmation (confirmation failed)" });
  assert.equal(prompts, 1);
  dialog.resolve(true);
  await flush();
  assert.equal(await h.call("unmatched", "lock-3"), undefined);
  assert.equal(prompts, 2);
});

test("L-7 a row bound before reset cannot rebind after reset and renders native only", async (t: TestContext) => {
  const h = await createHarness(t, { reviewMode: "manual", permissions: { allow: ["Bash(safe)"] } });
  const old = h.row("safe", "old-row");
  assert.equal(await h.call("safe", "old-row"), undefined);
  assert.match(old.row.render(100).join("\n"), /✓ approved · Bash\(safe\)/);
  await h.sessionStart();
  const widgetsBefore = h.widgets.length;
  assert.equal(await h.call("safe", "old-row"), undefined);
  assert.equal(h.widgets.length > widgetsBefore, true, "the stale binding routes the new attempt to the widget");
  const native = h.nativeRow("safe", "old-row-native").render(100);
  assert.deepEqual(old.row.render(100), native, "the old wrapper renders exactly the native row");
});

test("L-8 replacement session: an old unresolved dialog cannot overwrite the new session's row", async (t: TestContext) => {
  const dialog = deferred<boolean>();
  let prompts = 0;
  const h = await createHarness(t, { reviewMode: "manual", permissions: { allow: ["Bash(safe)"] }, confirm: () => {
    prompts++;
    if (prompts === 1) {
      dialog.arrive();
      return dialog.promise;
    }
    return Promise.resolve(true);
  } });
  const old = h.row("unmatched", "old");
  const oldPending = h.call("unmatched", "old");
  await dialog.enter;
  await h.sessionStart();
  assert.deepEqual(await oldPending, CANCELLED);
  const fresh = h.row("safe", "fresh");
  assert.equal(await h.call("safe", "fresh"), undefined);
  const freshText = plain(fresh.row.render(100));
  assert.equal(freshText.includes("✓ approved · Bash(safe)"), true, `fresh row shows its own approval: ${freshText.join(" | ")}`);
  const freshFrames = fresh.frames.length;
  const widgetsBeforeLate = [...h.widgets];
  dialog.resolve(true);
  await flush();
  assert.deepEqual(h.widgets, widgetsBeforeLate, "old settlement publishes no widget");
  assert.equal(fresh.frames.length, freshFrames, "old settlement publishes nothing to the replacement row");
  assert.equal(plain(fresh.row.render(100)).includes("✓ approved · Bash(safe)"), true);
  assert.equal(/approved/.test(old.row.render(100).join("\n")), false, "the old row keeps no status");
});

test("L-9 widget terminal cleanup runs after exactly 2000 ms and does not clear later publications", async (t: TestContext) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const h = await createHarness(t, { reviewMode: "manual", placement: "widget", permissions: { allow: ["Bash(safe)"] } });
  assert.equal(await h.call("safe", "w1"), undefined);
  const firstKey = h.widgets[0]?.[0];
  assert.equal(h.widgets.some((item) => item[0] === firstKey && item[1] === undefined), false);
  mock.timers.tick(1999);
  assert.equal(h.widgets.some((item) => item[0] === firstKey && item[1] === undefined), false, "not cleared before 2000 ms");
  mock.timers.tick(1);
  assert.equal(h.widgets.some((item) => item[0] === firstKey && item[1] === undefined), true, "cleared at 2000 ms");
  assert.equal(await h.call("safe", "w2"), undefined);
  const secondKey = h.widgets.at(-1)?.[0];
  assert.notEqual(secondKey, firstKey);
  mock.timers.tick(1999);
  assert.equal(h.widgets.some((item) => item[0] === secondKey && item[1] === undefined), false, "a later publication keeps its own 2000 ms window");
});

const WRITE_INPUT = { path: "notes.txt", content: "draft" };
const READ_INPUT = { path: "notes.txt" };

for (const reset of ["session_start", "session_shutdown"] as const) {
  test(`L-10 non-Bash ${reset} while confirmation is unresolved: one Cancelled widget transition, late approval publishes nothing`, async (t: TestContext) => {
    const dialog = deferred<boolean>();
    let prompts = 0;
    const h = await createHarness(t, { reviewMode: "manual", placement: "widget", confirm: () => {
      prompts++;
      if (prompts === 1) {
        dialog.arrive();
        return dialog.promise;
      }
      return Promise.resolve(true);
    } });
    const pending = h.callTool("write", WRITE_INPUT, "nb-1");
    await dialog.enter;
    const key = h.widgets[0]?.[0];
    if (reset === "session_start") await h.sessionStart();
    else h.shutdown();
    assert.deepEqual(await pending, CANCELLED);
    const afterCancel = h.widgets.length;
    dialog.resolve(true);
    await flush();
    assert.equal(h.widgets.length, afterCancel, `${reset}: no widget publication after the abandoned dialog settles`);
    assert.deepEqual(liveWidgetStates(h.widgets, key), ["reviewing", "blocked + Cancelled"], `${reset}: approval-required shows as reviewing (src/ui/status.ts:35), then exactly one attributed Cancelled transition`);
    assert.equal(h.widgets.some((item) => JSON.stringify(item).includes("approved")), false, "late approval never publishes");
    assert.equal(prompts, 1, "no second dialog after the abandoned one settles");
  });
}

test("L-11 non-Bash call while an unresolved confirmation holds the lock is blocked without a dialog; after settlement a new call prompts and approves", async (t: TestContext) => {
  const dialog = deferred<boolean>();
  let prompts = 0;
  const h = await createHarness(t, { reviewMode: "manual", placement: "widget", confirm: () => {
    prompts++;
    if (prompts === 1) {
      dialog.arrive();
      return dialog.promise;
    }
    return Promise.resolve(true);
  } });
  const first = h.callTool("write", WRITE_INPUT, "nb-lock-1");
  await dialog.enter;
  await h.sessionStart();
  assert.deepEqual(await first, CANCELLED);
  const rejected = await h.callTool("read", READ_INPUT, "nb-lock-2");
  assert.deepEqual(rejected, { block: true, reason: "Unmatched read call requires confirmation (confirmation failed)" }, "lock rejects an overlapping non-Bash dialog while the first is unresolved");
  assert.equal(prompts, 1, "no second non-Bash dialog opens while the first is unresolved");
  dialog.resolve(true);
  await flush();
  assert.equal(await h.callTool("read", READ_INPUT, "nb-lock-3"), undefined, "after the original dialog settles, a new non-Bash call may prompt and approve");
  assert.equal(prompts, 2);
});
