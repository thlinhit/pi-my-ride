import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPermissionsController } from "../src/permissions.ts";

function harness() {
  const root = mkdtempSync(join(tmpdir(), "permissions-menu-"));
  const globalDir = join(root, "global"); const cwd = join(root, "project");
  let choose: (value: string | undefined) => void = () => {};
  const messages: string[] = []; let cancels = 0;
  const ctx = { cwd, hasUI: true, ui: { select: async (_title: string, _options: string[]) => await new Promise<string | undefined>((resolve) => { choose = resolve; }), notify: (message: string) => messages.push(message) } } as never;
  const controller = createPermissionsController(globalDir, () => { cancels++; });
  return { root, globalDir, cwd, ctx, controller, messages, select: (v: string | undefined) => choose(v), cancels: () => cancels };
}

test("menu snapshot uses one saved-settings snapshot for change comparison", async () => {
  const h = harness();
  try {
    const pending = h.controller.menu("", h.ctx);
    await Promise.resolve();
    mkdirSync(h.globalDir, { recursive: true });
    writeFileSync(join(h.globalDir, "auto-permissions.json"), JSON.stringify({ enabled: false, reviewMode: "auto" }));
    h.select("Protection on"); await pending;
    assert.deepEqual(h.controller.snapshot(), { enabled: true });
    assert.equal(h.cancels(), 1, "compare against settings at selection, not menu opening");
    assert.match(h.messages.at(-1)!, /Protection on · auto/);
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("invalid saved config permits explicit off, but reports invalid state on enable and save", async () => {
  const h = harness(); mkdirSync(h.globalDir, { recursive: true }); writeFileSync(join(h.globalDir, "auto-permissions.json"), "{");
  try {
    let pending = h.controller.menu("", h.ctx); await Promise.resolve(); await Promise.resolve(); h.select("Protection off"); await pending;
    assert.equal(h.controller.snapshot().enabled, false);
    assert.doesNotMatch(h.messages.at(-1)!, /still blocks Bash/);
    pending = h.controller.menu("", h.ctx); await Promise.resolve(); await Promise.resolve(); h.select("Protection on"); await pending;
    assert.match(h.messages.at(-1)!, /invalid config still blocks Bash/);
    pending = h.controller.menu("", h.ctx); await Promise.resolve(); await Promise.resolve(); h.select("Save settings"); await pending;
    assert.match(h.messages.at(-1)!, /Could not save settings/);
    assert.equal(readFileSync(join(h.globalDir, "auto-permissions.json"), "utf8"), "{");
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("reset clears awaited explicit off for every session reason", async () => {
  const h = harness();
  try {
    for (const reason of ["startup", "reload", "new", "resume", "fork"] as const) {
      const pending = h.controller.menu("", h.ctx);
      await Promise.resolve();
      h.select("Protection off");
      await pending;
      assert.deepEqual(h.controller.snapshot(), { enabled: false }, reason);
      h.controller.reset(h.ctx);
      assert.deepEqual(h.controller.snapshot(), {});
    }
    assert.equal(h.cancels(), 10);
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("menu selection lock rejects overlap and reset invalidates a stale selection", async () => {
  const h = harness();
  try {
    const pending = h.controller.menu("", h.ctx); await Promise.resolve(); await Promise.resolve();
    await h.controller.menu("", h.ctx); assert.match(h.messages.at(-1)!, /already open/);
    h.controller.reset(h.ctx);
    await h.controller.menu("", h.ctx);
    assert.match(h.messages.at(-1)!, /already open/);
    h.select("Protection off"); await pending;
    assert.deepEqual(h.controller.snapshot(), {});
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});
