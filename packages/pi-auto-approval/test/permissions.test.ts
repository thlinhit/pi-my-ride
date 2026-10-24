import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPermissionsController } from "../src/permissions.ts";
import { loadGlobalConfig } from "../src/config.ts";

function harness() {
  const root = mkdtempSync(join(tmpdir(), "permissions-menu-"));
  const globalDir = join(root, "global"); const cwd = join(root, "project");
  let choose: (value: string | undefined) => void = () => {};
  const messages: string[] = []; let cancels = 0;
  const ctx = { cwd, hasUI: true, ui: { select: async (_title: string, _options: string[]) => await new Promise<string | undefined>((resolve) => { choose = resolve; }), notify: (message: string) => messages.push(message) } } as never;
  const controller = createPermissionsController(globalDir, () => { cancels++; });
  return { root, globalDir, cwd, ctx, controller, messages, select: (v: string | undefined) => choose(v), cancels: () => cancels };
}

test("debug toggles session only, saves, clears and resets without cancelling reviews", async () => {
  const h = harness();
  const select = async (label: string) => { const pending = h.controller.menu("", h.ctx); await Promise.resolve(); h.select(label); await pending; };
  try {
    await select("Debug: off");
    assert.equal(h.controller.snapshot().debug, true);
    assert.equal(loadGlobalConfig(h.globalDir).ok, true);
    await select("Save settings");
    const saved = loadGlobalConfig(h.globalDir); assert.ok(saved.ok); if (saved.ok) assert.equal(saved.debug, true);
    await select("Debug: on"); assert.equal(h.controller.snapshot().debug, false);
    await select("Clear session choices / reload"); assert.deepEqual(h.controller.snapshot(), {});
    assert.equal(h.cancels(), 0);
    mkdirSync(h.globalDir, { recursive: true }); writeFileSync(join(h.globalDir, "auto-permissions.json"), "{");
    await select("Debug: off"); assert.equal(h.controller.snapshot().debug, true);
    await select("Clear session choices / reload"); assert.equal(h.cancels(), 0);
    await select("Debug: off"); h.controller.reset(h.ctx); assert.deepEqual(h.controller.snapshot(), {});
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

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
    assert.doesNotMatch(h.messages.at(-1)!, /still blocks tools/);
    pending = h.controller.menu("", h.ctx); await Promise.resolve(); await Promise.resolve(); h.select("Protection on"); await pending;
    assert.match(h.messages.at(-1)!, /invalid config still blocks tools/);
    pending = h.controller.menu("", h.ctx); await Promise.resolve(); await Promise.resolve(); h.select("Save settings"); await pending;
    assert.match(h.messages.at(-1)!, /Could not save settings/);
    assert.equal(readFileSync(join(h.globalDir, "auto-permissions.json"), "utf8"), "{");
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("save settings reports that tools remain blocked by an invalid project config", async () => {
  const h = harness();
  try {
    mkdirSync(h.globalDir, { recursive: true });
    writeFileSync(join(h.globalDir, "auto-permissions.json"), JSON.stringify({ permissions: {}, reviewMode: "manual" }));
    mkdirSync(join(h.cwd, ".pi", "pi-auto-approval"), { recursive: true });
    writeFileSync(join(h.cwd, ".pi", "pi-auto-approval", "auto-permissions.json"), "{");
    const pending = h.controller.menu("", h.ctx);
    await Promise.resolve(); await Promise.resolve();
    h.select("Save settings"); await pending;
    assert.match(h.messages.at(-1)!, /^Tools remain blocked by config: /);
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

type PickerRequest = { readonly title: string; readonly options: string[]; readonly resolve: (value: string | undefined) => void };

function pickerHarness(models: { provider: string; id: string }[] = [], available = models) {
  const root = mkdtempSync(join(tmpdir(), "reviewer-picker-"));
  const globalDir = join(root, "global");
  mkdirSync(globalDir);
  const path = join(globalDir, "auto-permissions.json");
  writeFileSync(path, JSON.stringify({ permissions: {}, reviewer: { provider: "old", model: "old-model" } }));
  const registry = { getAll: () => models, getAvailable: () => available };
  const selects: PickerRequest[] = [];
  const messages: string[] = [];
  let cancels = 0;
  const ctx = {
    cwd: join(root, "project"), hasUI: true, mode: "rpc", modelRegistry: registry,
    ui: {
      select: (title: string, options: string[]) => new Promise<string | undefined>((resolve) => { selects.push({ title, options, resolve }); }),
      notify: (message: string, type?: string) => messages.push(`${type ?? "info"}:${message}`),
      setStatus: () => {},
    },
  } as never;
  const controller = createPermissionsController(globalDir, () => { cancels++; });
  return { root, globalDir, path, registry, ctx, controller, messages, selects, cancels: () => cancels, close: () => rmSync(root, { recursive: true, force: true }) };
}

async function nextPick(h: ReturnType<typeof pickerHarness>, index: number): Promise<PickerRequest> {
  for (let tick = 0; tick < 20 && h.selects.length <= index; tick++) await Promise.resolve();
  const request = h.selects[index];
  assert.ok(request, `select ${index + 1} was opened`);
  return request;
}

async function seedSessionChoices(h: ReturnType<typeof pickerHarness>): Promise<void> {
  for (const choice of ["Protection off", "Manual review"]) {
    const base = h.selects.length;
    const pending = h.controller.menu("", h.ctx);
    (await nextPick(h, base)).resolve(choice);
    await pending;
  }
  assert.deepEqual(h.controller.snapshot(), { enabled: false, reviewMode: "manual" });
}

async function pickReviewer(h: ReturnType<typeof pickerHarness>, choice: string): Promise<void> {
  const base = h.selects.length;
  const pending = h.controller.menu("", h.ctx);
  (await nextPick(h, base)).resolve("Reviewer model");
  (await nextPick(h, base + 1)).resolve(choice);
  await pending;
}

function assertClearRetained(h: ReturnType<typeof pickerHarness>, before: string, choices: object, cancels: number, notice: string): void {
  assert.equal(readFileSync(h.path, "utf8"), before);
  const saved = loadGlobalConfig(h.globalDir);
  assert.equal(saved.ok, true);
  if (saved.ok) assert.deepEqual(saved.reviewer.model, { provider: "old", id: "old-model" });
  assert.equal(h.cancels(), cancels);
  assert.deepEqual(h.controller.snapshot(), choices);
  assert.equal(h.messages.at(-1), notice);
  assert.deepEqual(fs.readdirSync(h.globalDir).filter((name) => name.startsWith(".auto-permissions.json.")), []);
}

test("reviewer picker is between Manual review and Save settings", async () => {
  const h = pickerHarness();
  try {
    const pending = h.controller.menu("", h.ctx);
    const main = await nextPick(h, 0);
    assert.deepEqual(main.options, ["Protection on", "Protection off", "Auto review", "Manual review", "Reviewer model", "Debug: off", "Save settings", "Clear session choices / reload"]);
    main.resolve(undefined); await pending;
  } finally { h.close(); }
});

test("reviewer picker keeps available order, numbers slash collisions, and excludes unconfigured models", async () => {
  const available = [{ provider: "p/a", id: "b" }, { provider: "p", id: "a/b" }];
  const h = pickerHarness([...available, { provider: "unconfigured", id: "model" }], available);
  try {
    const pending = h.controller.menu("", h.ctx);
    (await nextPick(h, 0)).resolve("Reviewer model");
    const picker = await nextPick(h, 1);
    assert.deepEqual(picker.options, ["Use active model", "1. p/a/b", "2. p/a/b"]);
    picker.resolve("2. p/a/b"); await pending;
    const saved = loadGlobalConfig(h.globalDir);
    assert.equal(saved.ok, true);
    if (saved.ok) assert.deepEqual(saved.reviewer.model, { provider: "p", id: "a/b" });
  } finally { h.close(); }
});

test("reviewer picker cancellation performs no write", async () => {
  const h = pickerHarness([{ provider: "p", id: "m" }]);
  try {
    const before = readFileSync(h.path, "utf8");
    const pending = h.controller.menu("", h.ctx);
    (await nextPick(h, 0)).resolve("Reviewer model");
    (await nextPick(h, 1)).resolve(undefined);
    await pending;
    assert.equal(readFileSync(h.path, "utf8"), before);
    assert.deepEqual(h.messages, []);
  } finally { h.close(); }
});

test("unknown reviewer label warns without writing", async () => {
  const h = pickerHarness([{ provider: "p", id: "m" }]);
  try {
    const before = readFileSync(h.path, "utf8");
    const pending = h.controller.menu("", h.ctx);
    (await nextPick(h, 0)).resolve("Reviewer model");
    (await nextPick(h, 1)).resolve("p/m"); await pending;
    assert.equal(readFileSync(h.path, "utf8"), before);
    assert.match(h.messages.join("\n"), /Unknown reviewer model: p\/m/);
  } finally { h.close(); }
});

test("registry enumeration failure reports error without opening the picker", async () => {
  const h = pickerHarness();
  try {
    h.registry.getAvailable = () => { throw new Error("registry offline"); };
    const pending = h.controller.menu("", h.ctx);
    (await nextPick(h, 0)).resolve("Reviewer model"); await pending;
    assert.equal(h.selects.length, 1);
    assert.match(h.messages.join("\n"), /Could not list models: registry offline/);
  } finally { h.close(); }
});

test("invalid saved config prevents the reviewer picker", async () => {
  const h = pickerHarness();
  try {
    writeFileSync(h.path, "{");
    const pending = h.controller.menu("", h.ctx);
    (await nextPick(h, 0)).resolve("Reviewer model"); await pending;
    assert.equal(h.selects.length, 1);
    assert.match(h.messages.join("\n"), /Saved config is invalid/);
  } finally { h.close(); }
});

test("reset while the reviewer picker is open discards its delayed choice", async () => {
  const h = pickerHarness([{ provider: "p", id: "m" }]);
  try {
    const pending = h.controller.menu("", h.ctx);
    (await nextPick(h, 0)).resolve("Reviewer model");
    const picker = await nextPick(h, 1);
    h.controller.reset(h.ctx);
    picker.resolve("1. p/m"); await pending;
    const saved = loadGlobalConfig(h.globalDir);
    assert.equal(saved.ok, true);
    if (saved.ok) assert.deepEqual(saved.reviewer.model, { provider: "old", id: "old-model" });
  } finally { h.close(); }
});

test("nested reviewer picker holds the menu lock and leaves the session snapshot unchanged", async () => {
  const h = pickerHarness([{ provider: "p", id: "m" }]);
  try {
    const pending = h.controller.menu("", h.ctx);
    (await nextPick(h, 0)).resolve("Reviewer model");
    const picker = await nextPick(h, 1);
    await h.controller.menu("", h.ctx);
    assert.equal(h.selects.length, 2);
    assert.match(h.messages.join("\n"), /already open/);
    picker.resolve("1. p/m"); await pending;
    assert.deepEqual(h.controller.snapshot(), {});
  } finally { h.close(); }
});

test("explicit reviewer selection saves immediately without cancelling work", async () => {
  const h = pickerHarness([{ provider: "p", id: "m" }]);
  try {
    await seedSessionChoices(h);
    const choices = h.controller.snapshot();
    const cancels = h.cancels();
    await pickReviewer(h, "1. p/m");
    const saved = loadGlobalConfig(h.globalDir);
    assert.equal(saved.ok, true);
    if (saved.ok) assert.deepEqual(saved.reviewer.model, { provider: "p", id: "m" });
    assert.equal(h.cancels(), cancels);
    assert.deepEqual(h.controller.snapshot(), choices);
    assert.deepEqual(choices, { enabled: false, reviewMode: "manual" });
    assert.match(h.messages.join("\n"), /Saved reviewer model.*auto-permissions\.json/);
  } finally { h.close(); }
});

test("partial reviewer save failure reports the retained prior selection", async () => {
  const h = pickerHarness([{ provider: "p", id: "m" }]);
  try {
    await seedSessionChoices(h);
    const choices = h.controller.snapshot();
    const cancels = h.cancels();
    const before = readFileSync(h.path, "utf8");
    const originalWrite = fs.writeFileSync;
    let injected = false;
    try {
      fs.writeFileSync = ((file: Parameters<typeof originalWrite>[0], data: Parameters<typeof originalWrite>[1], ...args: Parameters<typeof originalWrite>[2][]) => {
        if (String(file).includes("auto-permissions.json.")) { injected = true; originalWrite(file, String(data).slice(0, 5), ...args); throw new Error("partial failure"); }
        return originalWrite(file, data, ...args);
      }) as typeof fs.writeFileSync;
      syncBuiltinESMExports();
      await pickReviewer(h, "1. p/m");
    } finally { fs.writeFileSync = originalWrite; syncBuiltinESMExports(); }
    assert.equal(injected, true);
    assert.equal(readFileSync(h.path, "utf8"), before);
    const saved = loadGlobalConfig(h.globalDir);
    assert.equal(saved.ok, true);
    if (saved.ok) assert.deepEqual(saved.reviewer.model, { provider: "old", id: "old-model" });
    assert.equal(h.cancels(), cancels);
    assert.deepEqual(h.controller.snapshot(), choices);
    assert.deepEqual(choices, { enabled: false, reviewMode: "manual" });
    assert.match(h.messages.join("\n"), /previous selection retained/);
  } finally { h.close(); }
});

test("Use active model is the first reviewer option and clearing keeps other reviewer settings without cancelling", async () => {
  const h = pickerHarness([{ provider: "p", id: "m" }]);
  try {
    writeFileSync(h.path, JSON.stringify({ permissions: {}, reviewer: { provider: "p", model: "m", timeoutMs: 5000 } }));
    await seedSessionChoices(h);
    const choices = h.controller.snapshot();
    const cancels = h.cancels();
    const base = h.selects.length;
    const pending = h.controller.menu("", h.ctx);
    (await nextPick(h, base)).resolve("Reviewer model");
    const picker = await nextPick(h, base + 1);
    assert.deepEqual(picker.options, ["Use active model", "1. p/m"]);
    assert.equal(picker.title, "Reviewer model (current: p/m)");
    picker.resolve("Use active model"); await pending;
    assert.deepEqual(JSON.parse(readFileSync(h.path, "utf8")), { permissions: {}, reviewer: { timeoutMs: 5000 } });
    assert.equal(h.cancels(), cancels);
    assert.deepEqual(h.controller.snapshot(), choices);
    assert.deepEqual(choices, { enabled: false, reviewMode: "manual" });
    assert.match(h.messages.join("\n"), /info:Reviewer model: active model \(global override cleared\)/);
  } finally { h.close(); }
  const empty = pickerHarness();
  try {
    writeFileSync(empty.path, JSON.stringify({ permissions: {} }));
    await seedSessionChoices(empty);
    const choices = empty.controller.snapshot();
    const cancels = empty.cancels();
    const before = readFileSync(empty.path, "utf8");
    const base = empty.selects.length;
    const pending = empty.controller.menu("", empty.ctx);
    (await nextPick(empty, base)).resolve("Reviewer model");
    const picker = await nextPick(empty, base + 1);
    assert.deepEqual(picker.options, ["Use active model"]);
    assert.equal(picker.title, "Reviewer model (current: active model)");
    picker.resolve("Use active model"); await pending;
    assert.equal(readFileSync(empty.path, "utf8"), before);
    assert.equal(empty.cancels(), cancels);
    assert.deepEqual(empty.controller.snapshot(), choices);
    assert.match(empty.messages.join("\n"), /info:Reviewer model: active model \(global override cleared\)/);
  } finally { empty.close(); }
});

test("partial reviewer clear failure retains the prior persisted selection", async () => {
  const h = pickerHarness([{ provider: "p", id: "m" }]);
  try {
    await seedSessionChoices(h);
    const choices = h.controller.snapshot();
    const cancels = h.cancels();
    const before = readFileSync(h.path, "utf8");
    const originalWrite = fs.writeFileSync;
    let injected = false;
    try {
      fs.writeFileSync = ((file: Parameters<typeof originalWrite>[0], data: Parameters<typeof originalWrite>[1], ...args: Parameters<typeof originalWrite>[2][]) => {
        if (String(file).includes("auto-permissions.json.")) { injected = true; originalWrite(file, String(data).slice(0, 5), ...args); throw new Error("partial failure"); }
        return originalWrite(file, data, ...args);
      }) as typeof fs.writeFileSync;
      syncBuiltinESMExports();
      await pickReviewer(h, "Use active model");
    } finally { fs.writeFileSync = originalWrite; syncBuiltinESMExports(); }
    assert.equal(injected, true);
    assertClearRetained(h, before, choices, cancels, `error:Could not save reviewer model to ${h.path}: partial failure; previous selection retained`);

    const originalRename = fs.renameSync;
    let renameInjected = false;
    try {
      fs.renameSync = ((from: Parameters<typeof originalRename>[0], to: Parameters<typeof originalRename>[1]) => {
        if (String(to) === h.path) { renameInjected = true; throw new Error("injected rename failure"); }
        return originalRename(from, to);
      }) as typeof fs.renameSync;
      syncBuiltinESMExports();
      await pickReviewer(h, "Use active model");
    } finally { fs.renameSync = originalRename; syncBuiltinESMExports(); }
    assert.equal(renameInjected, true);
    assertClearRetained(h, before, choices, cancels, `error:Could not save reviewer model to ${h.path}: injected rename failure; previous selection retained`);
  } finally { h.close(); }
});
