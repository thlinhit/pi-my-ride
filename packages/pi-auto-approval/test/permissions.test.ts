import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPermissionsController } from "../src/permissions.ts";
import { loadGlobalConfig, projectConfigPath } from "../src/config.ts";
import { menuDriver } from "./permissions-menu-harness.ts";

function harness() {
  const root = mkdtempSync(join(tmpdir(), "permissions-menu-"));
  const globalDir = join(root, "global"), cwd = join(root, "project"); mkdirSync(globalDir);
  const path = join(globalDir, "auto-permissions.json");
  writeFileSync(path, JSON.stringify({ permissions: {}, reviewer: { provider: "old", model: "model", timeoutMs: 5000 } }));
  const driver = menuDriver(); const messages: string[] = []; const selects: { title: string; options: string[]; resolve: (value: string | undefined) => void }[] = [];
  let cancels = 0, clears = 0;
  const registry = { getAvailable: () => [{ provider: "p/a", id: "b" }, { provider: "p", id: "a/b" }] };
  const ctx = { cwd, hasUI: true, mode: "tui", model: { provider: "active", id: "live" }, modelRegistry: registry, ui: {
    custom: driver.custom, select: (title: string, options: string[]) => { assert.equal(driver.mounted, undefined, "screen disposed before picker"); return new Promise<string | undefined>(resolve => selects.push({ title, options, resolve })); },
    notify: (message: string) => messages.push(message), setStatus() {},
  } } as never;
  const controller = createPermissionsController(globalDir, () => { cancels++; }, () => { clears++; });
  let count = 0;
  return { root, globalDir, cwd, path, driver, messages, selects, registry, ctx, controller, cancels: () => cancels, clears: () => clears,
    open: () => controller.menu("", ctx), next: async () => driver.next(count++),
    async picker() { driver.row(2); for (let i = 0; i < 30; i++) await Promise.resolve(); const picker = selects.at(-1); assert.ok(picker); return picker; },
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("persistent four-row toggles, explicit save/reset, selection retention and exits", async () => {
  const h = harness();
  try {
    const before = readFileSync(h.path, "utf8"); let settled = false;
    const pending = h.open().then(() => { settled = true; }); await h.next();
    assert.equal(h.driver.mounted!.render(160).filter(line => /^[> ] /.test(line)).length, 4);
    for (const row of [0, 1, 3]) {
      h.driver.row(row); const screen = await h.next(); assert.ok(screen.render(160)[row + 1].startsWith("> ")); assert.equal(settled, false);
    }
    assert.deepEqual(h.controller.snapshot(), { enabled: false, reviewMode: "manual", debug: true });
    const picker = await h.picker(); assert.deepEqual(picker.options, ["Use active model", "1. p/a/b", "2. p/a/b"]);
    picker.resolve("2. p/a/b"); await h.next();
    assert.equal(readFileSync(h.path, "utf8"), before); assert.equal(h.cancels(), 2);
    h.driver.key("\u0007"); await h.next();
    const saved = loadGlobalConfig(h.globalDir); assert.ok(saved.ok); if (saved.ok) { assert.equal(saved.enabled, false); assert.equal(saved.reviewMode, "manual"); assert.equal(saved.debug, true); assert.deepEqual(saved.reviewer.model, { provider: "p", id: "a/b" }); }
    const bytes = readFileSync(h.path, "utf8"); h.driver.key("\u0012"); await h.next();
    assert.deepEqual(h.controller.snapshot(), {}); assert.equal(readFileSync(h.path, "utf8"), bytes); assert.equal(h.cancels(), 2); assert.equal(settled, false); assert.equal(h.clears(), 1);
    h.driver.key("\u0003"); await pending;
  } finally { h.close(); }
});

test("all binary rows toggle twice; closing keeps unsaved choices", async () => {
  const h = harness(); try {
    const bytes = readFileSync(h.path, "utf8"), pending = h.open(); await h.next();
    for (const row of [0, 1, 3]) for (let n = 0; n < 2; n++) { h.driver.row(row); await h.next(); }
    assert.deepEqual(h.controller.snapshot(), { enabled: true, reviewMode: "auto", debug: false }); assert.equal(h.clears(), 1);
    h.driver.key("\u001b"); await pending; assert.equal(readFileSync(h.path, "utf8"), bytes);
  } finally { h.close(); }
});

test("active override is session-only, cancelling preserves it; explicit save removes pair only", async () => {
  const h = harness(); try {
    const bytes = readFileSync(h.path, "utf8"), pending = h.open(); await h.next();
    (await h.picker()).resolve("Use active model"); await h.next();
    assert.equal(h.controller.snapshot().reviewerModel, null); assert.match(h.driver.mounted!.render(160).join("\n"), /active model \(active\/live\)/);
    const picker = await h.picker(); assert.match(picker.title, /active model/); picker.resolve(undefined); await h.next();
    assert.equal(readFileSync(h.path, "utf8"), bytes); assert.equal(h.cancels(), 0);
    h.driver.key("\u0007"); await h.next(); assert.deepEqual(JSON.parse(readFileSync(h.path, "utf8")).reviewer, { timeoutMs: 5000 });
    h.driver.key("\u001b"); await pending;
  } finally { h.close(); }
});

for (const failure of ["partial", "rename"] as const) test(`failed ${failure} save retains session and disk, reports no success, retry publishes`, async () => {
  const h = harness(); const write = fs.writeFileSync, rename = fs.renameSync;
  try {
    const bytes = readFileSync(h.path, "utf8"), pending = h.open(); await h.next(); (await h.picker()).resolve("1. p/a/b"); await h.next();
    if (failure === "partial") fs.writeFileSync = ((file, data, ...args: unknown[]) => { if (String(file).includes(".tmp")) { write(file, "partial"); throw new Error("partial failure"); } return (write as Function)(file, data, ...args); }) as typeof write;
    else fs.renameSync = () => { throw new Error("rename failure"); };
    syncBuiltinESMExports(); h.driver.key("\u0007"); await h.next(); fs.writeFileSync = write; fs.renameSync = rename; syncBuiltinESMExports();
    assert.equal(readFileSync(h.path, "utf8"), bytes); assert.deepEqual(h.controller.snapshot().reviewerModel, { provider: "p/a", id: "b" });
    assert.match(h.messages.at(-1)!, /Could not save settings/); assert.ok(!h.messages.some(message => message.startsWith("Saved settings"))); assert.equal(fs.readdirSync(h.globalDir).length, 1);
    h.driver.key("\u0007"); await h.next(); assert.match(h.messages.at(-1)!, /Saved settings/); h.driver.key("\u001b"); await pending;
  } finally { fs.writeFileSync = write; fs.renameSync = rename; syncBuiltinESMExports(); h.close(); }
});

for (const invalid of ["{", '{"debug":"bad"}']) test(`invalid global ${invalid} preserves escape hatch and refuses picker/save`, async () => {
  const h = harness(); try {
    writeFileSync(h.path, invalid); const pending = h.open(); await h.next(); assert.match(h.driver.mounted!.render(200).join("\n"), /invalid|boolean/);
    h.driver.row(0); await h.next(); assert.equal(h.controller.snapshot().enabled, false);
    h.driver.row(2); await h.next(); assert.equal(h.selects.length, 0); h.driver.row(0); await h.next(); assert.match(h.messages.at(-1)!, /invalid config still blocks/);
    h.driver.key("\u0007"); await h.next(); assert.match(h.messages.at(-1)!, /Could not save settings/); assert.equal(readFileSync(h.path, "utf8"), invalid);
    h.driver.key("\u001b"); await pending;
  } finally { h.close(); }
});

test("invalid project permits complete global save; reset reloads external settings without touching project rules", async () => {
  const h = harness(); try {
    const project = projectConfigPath(h.cwd); mkdirSync(join(h.cwd, ".pi", "pi-auto-approval"), { recursive: true }); writeFileSync(project, '{"debug":true}');
    const pending = h.open(); await h.next(); h.driver.key("\u0007"); await h.next(); assert.match(h.messages.at(-1)!, /Tools remain blocked/);
    h.driver.row(3); await h.next(); h.driver.row(0); await h.next();
    writeFileSync(h.path, '{"permissions":{},"enabled":true,"reviewMode":"manual","debug":false}'); writeFileSync(project, '{"permissions":{"deny":["Bash(bad)"]}}');
    const globalBytes = readFileSync(h.path, "utf8"), projectBytes = readFileSync(project, "utf8"); h.driver.key("\u0012"); await h.next();
    assert.deepEqual(h.controller.snapshot(), {}); assert.match(h.driver.mounted!.render(200).join("\n"), /Review mode: manual/); assert.equal(readFileSync(h.path, "utf8"), globalBytes); assert.equal(readFileSync(project, "utf8"), projectBytes);
    h.driver.key("\u001b"); await pending;
  } finally { h.close(); }
});

for (const lifecycle of ["reset", "close"] as const) for (const pickerOpen of [false, true]) test(`${lifecycle} invalidates ${pickerOpen ? "picker" : "custom"} and unlocks after settlement`, async () => {
  const h = harness(); try {
    const pending = h.open(); await h.next(); const picker = pickerOpen ? await h.picker() : undefined;
    await h.controller.menu("", h.ctx); assert.match(h.messages.at(-1)!, /already open/);
    if (lifecycle === "reset") h.controller.reset(h.ctx); else h.controller.close();
    picker?.resolve("1. p/a/b"); await pending; assert.deepEqual(h.controller.snapshot(), {});
    const reopened = h.open(); await h.next(); h.driver.key("\u001b"); await reopened;
  } finally { h.close(); }
});

test("arguments and non-TUI modes reject without opening; registry/custom/picker errors unlock", async () => {
  const h = harness(); try {
    await h.controller.menu("bad", h.ctx); assert.match(h.messages.at(-1)!, /arguments/);
    for (const mode of ["rpc", "print", "json"]) { await h.controller.menu("", { ...h.ctx as object, mode } as never); assert.match(h.messages.at(-1)!, /TUI/); }
    assert.equal(h.driver.screens.length, 0);
    h.registry.getAvailable = () => { throw new Error("registry offline"); }; const pending = h.open(); await h.next(); h.driver.row(2); await h.next(); assert.match(h.messages.at(-1)!, /Could not list models/); h.driver.key("\u001b"); await pending;
    for (const method of ["custom", "select"] as const) {
      const context = h.ctx as unknown as { ui: Record<string, unknown> }; const old = context.ui[method]; context.ui[method] = () => { throw new Error(`${method} broke`); };
      h.registry.getAvailable = () => []; const run = h.open(); if (method === "select") { await h.next(); h.driver.row(2); } await run;
      assert.match(h.messages.at(-1)!, /broke/); context.ui[method] = old;
    }
  } finally { h.close(); }
});
