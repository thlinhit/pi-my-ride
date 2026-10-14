import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as config from "../src/config.ts";
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

const saveReviewer = (globalDir: string, model: { provider: string; id: string } | undefined) => {
  assert.equal(typeof config.saveGlobalReviewerModel, "function", "reviewer saver is exported");
  return config.saveGlobalReviewerModel(globalDir, model);
};

test("reviewer save preserves unrelated raw config and reviewer options", () => {
  const t = temp(); mkdirSync(t.global, { recursive: true });
  try {
    const path = join(t.global, "auto-permissions.json");
    const raw = { enabled: false, reviewMode: "auto", rules: [rule], ui: { status: false, placement: "toolRow" }, reviewEvidence: { projectInstructions: true }, reviewer: { reasoningEffort: "high", timeoutMs: 4000, extraInstructionsFile: "instructions.md" } };
    writeFileSync(join(t.global, "instructions.md"), "instructions");
    writeFileSync(path, JSON.stringify(raw));
    assert.equal(saveReviewer(t.global, { provider: "p", id: "m" }).ok, true);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { ...raw, reviewer: { ...raw.reviewer, provider: "p", model: "m" } });
    const loaded = loadGlobalConfig(t.global);
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
      assert.equal(loaded.enabled, false);
      assert.equal(loaded.reviewMode, "auto");
      assert.deepEqual(loaded.rules.map(({ pattern, level, label, source, scope }) => ({ pattern: pattern.source, level, label, source, scope })), [{ pattern: rule.pattern, level: rule.level, label: rule.label, source: path, scope: "global" }]);
      assert.deepEqual(loaded.ui, raw.ui);
      assert.deepEqual(loaded.reviewEvidence, raw.reviewEvidence);
      assert.deepEqual(loaded.reviewer, { model: { provider: "p", id: "m" }, reasoningEffort: "high", timeoutMs: 4000, extraInstructions: "instructions" });
    }
  } finally { t.cleanup(); }
});

test("reviewer save creates minimal config when absent", () => {
  const t = temp();
  try { assert.equal(saveReviewer(t.global, { provider: "p", id: "m" }).ok, true); assert.deepEqual(JSON.parse(readFileSync(join(t.global, "auto-permissions.json"), "utf8")), { rules: [], reviewer: { provider: "p", model: "m" } }); } finally { t.cleanup(); }
});
test("reviewer save replaces pair retaining reviewer options", () => {
  const t = temp(); mkdirSync(t.global, { recursive: true });
  try { const path = join(t.global, "auto-permissions.json"); writeFileSync(path, JSON.stringify({ rules: [], reviewer: { provider: "a", model: "b", reasoningEffort: "high", timeoutMs: 5000, extraInstructions: "x" } })); assert.equal(saveReviewer(t.global, { provider: "c", id: "d" }).ok, true); assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).reviewer, { provider: "c", model: "d", reasoningEffort: "high", timeoutMs: 5000, extraInstructions: "x" }); } finally { t.cleanup(); }
});
test("reviewer clear removes pair preserving other options", () => { const t = temp(); mkdirSync(t.global, { recursive: true }); try { const path = join(t.global, "auto-permissions.json"); writeFileSync(path, JSON.stringify({ rules: [], reviewer: { provider: "a", model: "b", timeoutMs: 5000 } })); assert.equal(saveReviewer(t.global, undefined).ok, true); assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).reviewer, { timeoutMs: 5000 }); } finally { t.cleanup(); } });
test("reviewer clear removes empty reviewer object", () => { const t = temp(); mkdirSync(t.global, { recursive: true }); try { const path = join(t.global, "auto-permissions.json"); writeFileSync(path, JSON.stringify({ rules: [], reviewer: { provider: "a", model: "b" } })); assert.equal(saveReviewer(t.global, undefined).ok, true); assert.equal("reviewer" in JSON.parse(readFileSync(path, "utf8")), false); } finally { t.cleanup(); } });
test("reviewer clear no-op leaves absent and unset files untouched", () => { const t = temp(); mkdirSync(t.global, { recursive: true }); try { const path = join(t.global, "auto-permissions.json"); assert.equal(saveReviewer(t.global, undefined).ok, true); assert.equal(fs.existsSync(path), false); for (const bytes of ['{ "rules": [] }', '{"rules":[],"reviewer":{}}']) { writeFileSync(path, bytes); assert.equal(saveReviewer(t.global, undefined).ok, true); assert.equal(readFileSync(path, "utf8"), bytes); } } finally { t.cleanup(); } });
test("reviewer save refuses malformed JSON retaining bytes", () => { const t = temp(); mkdirSync(t.global, { recursive: true }); try { const path = join(t.global, "auto-permissions.json"); writeFileSync(path, "{broken"); assert.equal(saveReviewer(t.global, { provider: "p", id: "m" }).ok, false); assert.equal(readFileSync(path, "utf8"), "{broken"); } finally { t.cleanup(); } });
test("reviewer no-op clear validates existing config", () => { const t = temp(); mkdirSync(t.global, { recursive: true }); try { const path = join(t.global, "auto-permissions.json"); const bytes = JSON.stringify({ reviewer: { provider: "p" } }); writeFileSync(path, bytes); assert.equal(saveReviewer(t.global, undefined).ok, false); assert.equal(readFileSync(path, "utf8"), bytes); } finally { t.cleanup(); } });
test("reviewer save rejects blank pair without changing bytes", () => { const t = temp(); mkdirSync(t.global, { recursive: true }); try { const path = join(t.global, "auto-permissions.json"); const bytes = JSON.stringify({ rules: [] }); writeFileSync(path, bytes); assert.equal(saveReviewer(t.global, { provider: " ", id: "m" }).ok, false); assert.equal(readFileSync(path, "utf8"), bytes); } finally { t.cleanup(); } });
test("reviewer write stages bytes before a partial write failure", () => { const t = temp(); mkdirSync(t.global, { recursive: true }); try { const path = join(t.global, "auto-permissions.json"); const original = JSON.stringify({ rules: [], reviewer: { provider: "old", model: "old-id" } }); writeFileSync(path, original); const beforeWrite = fs.writeFileSync; let injected = false; fs.writeFileSync = ((file: Parameters<typeof beforeWrite>[0], data: Parameters<typeof beforeWrite>[1], ...args: Parameters<typeof beforeWrite>[2][]) => { if (String(file) === path || String(file).startsWith(`${path}.`) || String(file).includes(`.${"auto-permissions.json"}.`)) { injected = true; beforeWrite(file, String(data).slice(0, 4), ...args); throw new Error("injected partial write"); } return beforeWrite(file, data, ...args); }) as typeof fs.writeFileSync; syncBuiltinESMExports(); try { assert.equal(saveReviewer(t.global, { provider: "new", id: "new-id" }).ok, false); } finally { fs.writeFileSync = beforeWrite; syncBuiltinESMExports(); } assert.equal(injected, true); assert.equal(readFileSync(path, "utf8"), original); const loaded = loadGlobalConfig(t.global); assert.equal(loaded.ok, true); if (loaded.ok) assert.deepEqual(loaded.reviewer.model, { provider: "old", id: "old-id" }); assert.deepEqual(fs.readdirSync(t.global), ["auto-permissions.json"]); } finally { t.cleanup(); } });
test("reviewer rename failures preserve existing and absent targets", () => { const t = temp(); mkdirSync(t.global, { recursive: true }); const original = fs.renameSync; try { const path = join(t.global, "auto-permissions.json"); const originalBytes = JSON.stringify({ rules: [], reviewer: { provider: "old", model: "old-id" } }); for (const exists of [true, false]) { if (exists) writeFileSync(path, originalBytes); else rmSync(path, { force: true }); fs.renameSync = (() => { throw new Error("rename denied"); }) as typeof fs.renameSync; syncBuiltinESMExports(); try { assert.equal(saveReviewer(t.global, { provider: "p", id: "m" }).ok, false); } finally { fs.renameSync = original; syncBuiltinESMExports(); } assert.equal(fs.existsSync(path), exists); if (exists) { assert.equal(readFileSync(path, "utf8"), originalBytes); const loaded = loadGlobalConfig(t.global); assert.equal(loaded.ok, true); if (loaded.ok) assert.deepEqual(loaded.reviewer.model, { provider: "old", id: "old-id" }); } assert.deepEqual(fs.readdirSync(t.global), exists ? ["auto-permissions.json"] : []); } } finally { fs.renameSync = original; syncBuiltinESMExports(); t.cleanup(); } });
test("reviewer save detects content changes during staging", () => { const t = temp(); mkdirSync(t.global, { recursive: true }); const path = join(t.global, "auto-permissions.json"); try { const initial = JSON.stringify({ rules: [] }); writeFileSync(path, initial); const original = fs.readFileSync; let reads = 0; fs.readFileSync = ((file: Parameters<typeof original>[0], ...args: Parameters<typeof original>[1][]) => { if (String(file) === path && ++reads === 2) writeFileSync(path, "external"); return original(file as never, ...(args as [never])); }) as typeof fs.readFileSync; syncBuiltinESMExports(); try { const result = saveReviewer(t.global, { provider: "p", id: "m" }); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error, "config changed during save; refusing to overwrite"); } finally { fs.readFileSync = original; syncBuiltinESMExports(); } assert.equal(readFileSync(path, "utf8"), "external"); assert.deepEqual(fs.readdirSync(t.global), ["auto-permissions.json"]); } finally { t.cleanup(); } });
test("reviewer save detects target deletion or appearance", () => { for (const change of ["deletion", "appearance"]) { const t = temp(); mkdirSync(t.global, { recursive: true }); const path = join(t.global, "auto-permissions.json"); try { if (change === "deletion") writeFileSync(path, JSON.stringify({ rules: [] })); const original = fs.readFileSync; let reads = 0; fs.readFileSync = ((file: Parameters<typeof original>[0], ...args: Parameters<typeof original>[1][]) => { if (String(file) === path && ++reads === 2) { if (change === "deletion") rmSync(path); else writeFileSync(path, "external"); } return original(file as never, ...(args as [never])); }) as typeof fs.readFileSync; syncBuiltinESMExports(); try { assert.equal(saveReviewer(t.global, { provider: "p", id: "m" }).ok, false); } finally { fs.readFileSync = original; syncBuiltinESMExports(); } assert.equal(fs.existsSync(path), change === "appearance"); if (change === "appearance") assert.equal(readFileSync(path, "utf8"), "external"); assert.deepEqual(fs.readdirSync(t.global), change === "appearance" ? ["auto-permissions.json"] : []); } finally { t.cleanup(); } } });
test("reviewer atomic replacement preserves restrictive mode and leaves no staging files", () => { const t = temp(); mkdirSync(t.global, { recursive: true }); try { const path = join(t.global, "auto-permissions.json"); writeFileSync(path, JSON.stringify({ rules: [] })); chmodSync(path, 0o640); const previousUmask = process.umask(0o077); try { assert.equal(saveReviewer(t.global, { provider: "p", id: "m" }).ok, true); } finally { process.umask(previousUmask); } assert.equal(fs.statSync(path).mode & 0o777, 0o640); assert.deepEqual(fs.readdirSync(t.global), ["auto-permissions.json"]); } finally { t.cleanup(); } });
test("existing settings saver preserves reviewer pair", () => { const t = temp(); mkdirSync(t.global, { recursive: true }); try { const path = join(t.global, "auto-permissions.json"); writeFileSync(path, JSON.stringify({ rules: [], reviewer: { provider: "p", model: "m" } })); assert.equal(saveGlobalSettings(t.global, { enabled: false, reviewMode: "auto" }).ok, true); assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).reviewer, { provider: "p", model: "m" }); } finally { t.cleanup(); } });

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
