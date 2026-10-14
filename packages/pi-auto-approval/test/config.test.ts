import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, loadGlobalConfig, parseConfig, saveGlobalSettings } from "../src/config.ts";

const rule = { pattern: "^cmd$", level: "ask", label: "cmd" };
function temp() { const root = mkdtempSync(join(tmpdir(), "permissions-")); return { root, global: join(root, "global"), cwd: join(root, "project"), cleanup: () => rmSync(root, { recursive: true, force: true }) }; }

test("defaults and strict new rule schema", () => {
  const parsed = parseConfig({}, "global.json");
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.enabled, true);
    assert.equal(parsed.reviewMode, "manual");
    assert.deepEqual(parsed.rules, []);
    assert.deepEqual(parsed.ui, { status: true, placement: "widget" });
  }
  for (const raw of [{ rules: [rule] }, { rules: [{ ...rule, level: "deny" }] }, { rules: [{ ...rule, level: "allow" }] }]) assert.equal(parseConfig(raw, "cfg").ok, true);
  for (const raw of [{ guardian: "off" }, { enabled: "false" }, { reviewMode: "atuo" }, { rules: {} }, { rules: [{ ...rule, group: "x" }] }, { rules: [{ ...rule, level: "guarded" }] }]) assert.equal(parseConfig(raw, "cfg").ok, false);
});

test("project rules merge after global rules; project settings are rejected", () => {
  const t = temp();
  try {
    mkdirSync(join(t.cwd, ".pi"), { recursive: true }); mkdirSync(t.global, { recursive: true });
    writeFileSync(join(t.global, "auto-permissions.json"), JSON.stringify({ rules: [rule] }));
    writeFileSync(join(t.cwd, ".pi", "auto-permissions.json"), JSON.stringify({ rules: [{ ...rule, label: "project" }] }));
    const loaded = loadConfig(t.cwd, t.global);
    assert.equal(loaded.ok, true);
    if (loaded.ok) assert.deepEqual(loaded.rules.map((r) => [r.label, r.scope]), [["cmd", "global"], ["project", "project"]]);
    writeFileSync(join(t.cwd, ".pi", "auto-permissions.json"), JSON.stringify({ enabled: false }));
    const invalid = loadConfig(t.cwd, t.global);
    assert.equal(invalid.ok, false); if (!invalid.ok) assert.match(invalid.error, /project/);
  } finally { t.cleanup(); }
});

test("save creates global config, preserves fields, refuses invalid targets, and rejects concurrent edits", async () => {
  const t = temp();
  try {
    const created = saveGlobalSettings(t.global, { enabled: false, reviewMode: "auto" });
    assert.equal(created.ok, true);
    const path = join(t.global, "auto-permissions.json");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { enabled: false, reviewMode: "auto", rules: [] });
    writeFileSync(path, JSON.stringify({ enabled: true, reviewMode: "manual", rules: [rule], ui: { status: false, placement: "toolRow" } }));
    assert.equal(saveGlobalSettings(t.global, { enabled: false, reviewMode: "auto" }).ok, true);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(saved.ui.status, false);
    assert.equal(saved.ui.placement, "toolRow");
    assert.equal(saved.rules[0].label, "cmd");
    assert.equal(saved.enabled, false);
    assert.equal(saved.reviewMode, "auto");
    writeFileSync(path, "{broken");
    assert.equal(saveGlobalSettings(t.global, { enabled: true, reviewMode: "manual" }).ok, false);
    assert.equal(readFileSync(path, "utf8"), "{broken");
    assert.equal(loadGlobalConfig(t.global).ok, false);
    rmSync(path);
    const defaults = loadGlobalConfig(t.global);
    assert.equal(defaults.ok, true);
    if (defaults.ok) assert.deepEqual(defaults.ui, { status: true, placement: "widget" });
    for (const change of ["modification", "deletion", "appearance"]) {
    if (change === "appearance") rmSync(path, { force: true }); else writeFileSync(path, JSON.stringify({ enabled: true, rules: [] }));
    const original = fs.readFileSync;
    let targetReads = 0;
    fs.readFileSync = ((file: Parameters<typeof original>[0], ...args: Parameters<typeof original>[1][]) => {
      if (String(file) === path && ++targetReads === 2) {
        if (change === "deletion") rmSync(path); else writeFileSync(path, "external edit");
      }
      return original(file as never, ...(args as [never]));
    }) as typeof fs.readFileSync;
    syncBuiltinESMExports();
    try {
      const conflict = saveGlobalSettings(t.global, { enabled: false, reviewMode: "auto" });
      assert.equal(conflict.ok, false, change);
      if (!conflict.ok) assert.match(conflict.error, /config changed during save/);
      if (change === "deletion") assert.throws(() => readFileSync(path), { code: "ENOENT" });
      else assert.equal(readFileSync(path, "utf8"), "external edit");
    } finally {
      fs.readFileSync = original;
      syncBuiltinESMExports();
    }
    }
  } finally { t.cleanup(); }
});

test("strict nested configuration and values reject malformed inputs with source attribution", () => {
  const invalid = [null, [], { unknown: true },
    ...["reviewer", "reviewEvidence", "ui"].flatMap((key) => [ { [key]: null }, { [key]: [] }, { [key]: { unknown: true } } ]),
    ...["g", "y", "ii", "q", 1].map((flags) => ({ rules: [{ ...rule, flags }] })),
    ...[{ pattern: "[" }, { pattern: " " }, { label: " " }, { message: " " }, { message: 1 }, { level: "trusted" }, { old: true }].map((value) => ({ rules: [{ ...rule, ...value }] })),
    { rules: [null] }, { rules: [[]] },
    { reviewer: { provider: "p" } }, { reviewer: { model: "m" } }, { reviewer: { provider: " ", model: "m" } },
    { reviewer: { provider: "p", model: 1 } }, { reviewer: { reasoningEffort: "invalid" } },
    ...[999, 300001, 1000.5, "1000", null].map((timeoutMs) => ({ reviewer: { timeoutMs } })),
    { reviewer: { extraInstructions: " " } }, { reviewer: { extraInstructionsFile: " " } },
    { reviewer: { extraInstructions: "x", extraInstructionsFile: "x" } },
    { reviewer: { extraInstructionsFile: "/nonexistent-phase45-instructions" } },
    { ui: { status: 0 } },
    ...[null, 1, true, "", "invalid"].map((placement) => ({ ui: { placement } })),
    { ui: { status: true, placement: "toolRow", unknown: true } },
    { reviewEvidence: { projectInstructions: "true" } },
  ];
  for (const value of invalid) {
    const result = parseConfig(value, "validation.json");
    assert.equal(result.ok, false, JSON.stringify(value));
    if (!result.ok) assert.match(result.error, /validation.json/);
  }
  for (const key of ["enabled", "reviewMode", "reviewer", "reviewEvidence", "ui", "guardian"]) {
    assert.equal(parseConfig({ [key]: {} }, "project.json", ".", "project").ok, false, key);
  }
  assert.equal(parseConfig({ ui: { placement: "bad" } }, "global.json").ok, false);
  const invalidPlacement = parseConfig({ ui: { placement: null } }, "global.json");
  assert.deepEqual(invalidPlacement, { ok: false, error: "global.json: ui.placement must be widget or toolRow" });
  const projectUi = parseConfig({ ui: { placement: "toolRow" } }, "project.json", ".", "project");
  assert.deepEqual(projectUi, { ok: false, error: "project.json: unsupported field \"ui\"" });
  for (const timeoutMs of [1000, 300000]) assert.equal(parseConfig({ reviewer: { timeoutMs } }, "cfg").ok, true);
  for (const reasoningEffort of ["minimal", "low", "medium", "high", "xhigh", "max"]) assert.equal(parseConfig({ reviewer: { reasoningEffort } }, "cfg").ok, true);
  const t = temp();
  try {
    writeFileSync(join(t.root, "instructions.md"), "read carefully");
    const result = parseConfig({ reviewer: { extraInstructionsFile: "instructions.md" } }, "cfg", t.root);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.reviewer.extraInstructions, "read carefully");
    writeFileSync(join(t.root, "instructions.md"), " \n");
    assert.equal(parseConfig({ reviewer: { extraInstructionsFile: "instructions.md" } }, "cfg", t.root).ok, false);
    mkdirSync(join(t.cwd, ".pi"), { recursive: true }); mkdirSync(t.global);
    writeFileSync(join(t.global, "auto-permissions.json"), JSON.stringify({ enabled: false }));
    writeFileSync(join(t.cwd, ".pi", "auto-permissions.json"), "{broken");
    assert.equal(loadConfig(t.cwd, t.global).ok, false, "saved off still validates project");
  } finally { t.cleanup(); }
});
