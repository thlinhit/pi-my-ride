import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as config from "../src/config.ts";
import { loadConfig, loadGlobalConfig, parseConfig, saveGlobalSettings, globalConfigDir, projectConfigPath, SEED_CONFIG } from "../src/config.ts";

const rule = "Bash(cmd)";
const seedLabels = () => [...SEED_CONFIG.permissions.deny, ...SEED_CONFIG.permissions.ask, ...SEED_CONFIG.permissions.allow];
function temp() { const root = mkdtempSync(join(tmpdir(), "permissions-")); return { root, global: join(root, "home", ".pi", "pi-auto-approval"), cwd: join(root, "project"), cleanup: () => rmSync(root, { recursive: true, force: true }) }; }

test("directory targets are unreadable config errors for global and project paths", () => {
  const t = temp();
  try {
    mkdirSync(join(t.global, "auto-permissions.json"), { recursive: true });
    const global = loadGlobalConfig(t.global);
    assert.equal(global.ok, false);
    if (!global.ok) assert.match(global.error, /cannot read config/);
    mkdirSync(join(t.cwd, ".pi", "pi-auto-approval", "auto-permissions.json"), { recursive: true });
    const project = loadConfig(t.cwd, t.global);
    assert.equal(project.ok, false);
    if (!project.ok) assert.match(project.error, /cannot read config/);
  } finally { t.cleanup(); }
});

test("missing-file settings save clones the seed policy and reloads", () => {
  const t = temp();
  const originalSeed = structuredClone(SEED_CONFIG);
  try {
    assert.equal(saveGlobalSettings(t.global, { enabled: false, reviewMode: "auto" }).ok, true);
    assert.deepEqual(JSON.parse(readFileSync(join(t.global, "auto-permissions.json"), "utf8")), { ...structuredClone(SEED_CONFIG), enabled: false, reviewMode: "auto" });
    const loaded = loadGlobalConfig(t.global);
    assert.equal(loaded.ok, true);
    if (loaded.ok) assert.deepEqual(loaded.rules.map(({ label }) => label), seedLabels());
    assert.deepEqual(SEED_CONFIG, originalSeed);
  } finally { t.cleanup(); }
});

test("permissions schema, paths, and absent global policy use the approved seed without writing", () => {
  const t = temp();
  try {
    assert.equal(globalConfigDir(t.root), join(t.root, ".pi", "pi-auto-approval"));
    assert.equal(projectConfigPath(t.cwd), join(t.cwd, ".pi", "pi-auto-approval", "auto-permissions.json"));
    const parsed = parseConfig({ permissions: { allow: ["Bash(git status)"], ask: [], deny: [], defaultMode: "manual" } }, "global.json");
    assert.equal(parsed.ok, true);
    if (parsed.ok) { assert.equal(parsed.reviewMode, "auto"); assert.equal(parsed.rules[0]?.label, "Bash(git status)"); }
    assert.equal(parseConfig({ permissions: { allow: [], ask: [], deny: [], defaultMode: "auto" } }, "bad.json").ok, false);
    const loaded = loadConfig(t.cwd, t.global);
    assert.equal(loaded.ok, true);
    if (loaded.ok) { assert.equal(loaded.reviewMode, "auto"); assert.deepEqual(loaded.rules.map((r) => r.label), seedLabels()); }
    assert.equal(fs.existsSync(join(t.global, "auto-permissions.json")), false);
    assert.equal(fs.existsSync(projectConfigPath(t.cwd)), false);
  } finally { t.cleanup(); }
});

test("empty valid permissions produce no rules and defaults are auto/manual-free", () => {
  const empty = parseConfig({ permissions: { allow: [], ask: [], deny: [] } }, "global.json");
  assert.equal(empty.ok, true);
  if (empty.ok) { assert.deepEqual(empty.rules, []); assert.equal(empty.reviewMode, "auto"); }
  const parsed = parseConfig({}, "global.json");
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.enabled, true);
    assert.equal(parsed.reviewMode, "auto");
    assert.deepEqual(parsed.rules, []);
    assert.deepEqual(parsed.ui, { status: true, placement: "widget" });
  }
  for (const raw of [{ permissions: { allow: [rule] } }, { permissions: { deny: [rule] } }, { permissions: { ask: [rule] } }, { permissions: { allow: ["Bash"] } }, { permissions: { ask: ["Read(./.env)"] } }]) assert.equal(parseConfig(raw, "cfg").ok, true, JSON.stringify(raw));
  for (const raw of [{ guardian: "off" }, { enabled: "false" }, { reviewMode: "atuo" }, { permissions: null }, { permissions: [] }, { permissions: { unknown: [] } }, { permissions: { allow: {} } }, { permissions: { allow: [null] } }]) assert.equal(parseConfig(raw, "cfg").ok, false, JSON.stringify(raw));
});

test("legacy rules key is rejected at both new paths and old paths are ignored", () => {
  const t = temp();
  try {
    mkdirSync(t.global, { recursive: true }); mkdirSync(join(t.cwd, ".pi", "pi-auto-approval"), { recursive: true });
    writeFileSync(join(t.global, "auto-permissions.json"), JSON.stringify({ rules: [] }));
    const globalLegacy = loadGlobalConfig(t.global);
    assert.equal(globalLegacy.ok, false);
    if (!globalLegacy.ok) assert.match(globalLegacy.error, /unsupported field "rules"/);
    rmSync(join(t.global, "auto-permissions.json"));
    writeFileSync(projectConfigPath(t.cwd), JSON.stringify({ rules: [] }));
    const projectLegacy = loadConfig(t.cwd, t.global);
    assert.equal(projectLegacy.ok, false);
    if (!projectLegacy.ok) assert.match(projectLegacy.error, /unsupported field "rules"/);
    rmSync(projectConfigPath(t.cwd));
    writeFileSync(join(t.root, "home", ".pi", "auto-permissions.json"), JSON.stringify({ rules: [{ pattern: "legacy", level: "allow", label: "legacy" }] }));
    mkdirSync(join(t.cwd, ".pi"), { recursive: true });
    writeFileSync(join(t.cwd, ".pi", "auto-permissions.json"), JSON.stringify({ rules: [] }));
    const ignored = loadConfig(t.cwd, t.global);
    assert.equal(ignored.ok, true);
    if (ignored.ok) assert.deepEqual(ignored.rules.map((r) => r.label), seedLabels());
  } finally { t.cleanup(); }
});

test("project defaultMode is rejected while global defaultMode must be manual", () => {
  const project = parseConfig({ permissions: { allow: [], defaultMode: "manual" } }, "project.json", ".", "project");
  assert.equal(project.ok, false);
  if (!project.ok) assert.match(project.error, /unsupported field "defaultMode"/);
  assert.equal(parseConfig({ permissions: { defaultMode: "auto" } }, "global.json").ok, false);
  assert.equal(parseConfig({ permissions: { defaultMode: "manual" } }, "global.json").ok, true);
});

test("project permissions merge after global rules; project settings are rejected", () => {
  const t = temp();
  try {
    mkdirSync(join(t.cwd, ".pi", "pi-auto-approval"), { recursive: true }); mkdirSync(t.global, { recursive: true });
    writeFileSync(join(t.global, "auto-permissions.json"), JSON.stringify({ permissions: { ask: [rule] } }));
    writeFileSync(projectConfigPath(t.cwd), JSON.stringify({ permissions: { ask: ["Bash(project)"] } }));
    const loaded = loadConfig(t.cwd, t.global);
    assert.equal(loaded.ok, true);
    if (loaded.ok) assert.deepEqual(loaded.rules.map((r) => [r.label, r.scope]), [["Bash(cmd)", "global"], ["Bash(project)", "project"]]);
    writeFileSync(projectConfigPath(t.cwd), JSON.stringify({ enabled: false }));
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
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { ...structuredClone(SEED_CONFIG), enabled: false, reviewMode: "auto" });
    writeFileSync(path, JSON.stringify({ enabled: true, reviewMode: "manual", permissions: { ask: [rule] }, ui: { status: false, placement: "toolRow" } }));
    assert.equal(saveGlobalSettings(t.global, { enabled: false, reviewMode: "auto" }).ok, true);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(saved.ui.status, false);
    assert.equal(saved.ui.placement, "toolRow");
    assert.deepEqual(saved.permissions.ask, [rule]);
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
    if (change === "appearance") rmSync(path, { force: true }); else writeFileSync(path, JSON.stringify({ enabled: true, permissions: {} }));
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
    const raw = { enabled: false, reviewMode: "auto", permissions: { ask: [rule] }, ui: { status: false, placement: "toolRow" }, reviewEvidence: { projectInstructions: true }, reviewer: { reasoningEffort: "high", timeoutMs: 4000, extraInstructionsFile: "instructions.md" } };
    writeFileSync(join(t.global, "instructions.md"), "instructions");
    writeFileSync(path, JSON.stringify(raw));
    assert.equal(saveReviewer(t.global, { provider: "p", id: "m" }).ok, true);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { ...raw, reviewer: { ...raw.reviewer, provider: "p", model: "m" } });
    const loaded = loadGlobalConfig(t.global);
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
      assert.equal(loaded.enabled, false);
      assert.equal(loaded.reviewMode, "auto");
      assert.deepEqual(loaded.rules.map(({ tool, specifier, level, label, source, scope }) => ({ tool, specifier, level, label, source, scope })), [{ tool: "bash", specifier: "cmd", level: "ask", label: rule, source: path, scope: "global" }]);
      assert.deepEqual(loaded.ui, raw.ui);
      assert.deepEqual(loaded.reviewEvidence, raw.reviewEvidence);
      assert.deepEqual(loaded.reviewer, { model: { provider: "p", id: "m" }, reasoningEffort: "high", timeoutMs: 4000, extraInstructions: "instructions" });
    }
  } finally { t.cleanup(); }
});

test("reviewer save creates a seed-based config when absent", () => {
  const t = temp();
  try { assert.equal(saveReviewer(t.global, { provider: "p", id: "m" }).ok, true); assert.deepEqual(JSON.parse(readFileSync(join(t.global, "auto-permissions.json"), "utf8")), { ...structuredClone(SEED_CONFIG), reviewer: { provider: "p", model: "m" } }); } finally { t.cleanup(); }
});
test("reviewer save replaces pair retaining reviewer options", () => {
  const t = temp(); mkdirSync(t.global, { recursive: true });
  try { const path = join(t.global, "auto-permissions.json"); writeFileSync(path, JSON.stringify({ permissions: {}, reviewer: { provider: "a", model: "b", reasoningEffort: "high", timeoutMs: 5000, extraInstructions: "x" } })); assert.equal(saveReviewer(t.global, { provider: "c", id: "d" }).ok, true); assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).reviewer, { provider: "c", model: "d", reasoningEffort: "high", timeoutMs: 5000, extraInstructions: "x" }); } finally { t.cleanup(); }
});
test("reviewer clear removes pair preserving other options", () => { const t = temp(); mkdirSync(t.global, { recursive: true }); try { const path = join(t.global, "auto-permissions.json"); writeFileSync(path, JSON.stringify({ permissions: {}, reviewer: { provider: "a", model: "b", timeoutMs: 5000 } })); assert.equal(saveReviewer(t.global, undefined).ok, true); assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).reviewer, { timeoutMs: 5000 }); } finally { t.cleanup(); } });
test("reviewer clear removes empty reviewer object", () => { const t = temp(); mkdirSync(t.global, { recursive: true }); try { const path = join(t.global, "auto-permissions.json"); writeFileSync(path, JSON.stringify({ permissions: {}, reviewer: { provider: "a", model: "b" } })); assert.equal(saveReviewer(t.global, undefined).ok, true); assert.equal("reviewer" in JSON.parse(readFileSync(path, "utf8")), false); } finally { t.cleanup(); } });
test("reviewer clear no-op leaves absent and unset files untouched", () => { const t = temp(); mkdirSync(t.global, { recursive: true }); try { const path = join(t.global, "auto-permissions.json"); assert.equal(saveReviewer(t.global, undefined).ok, true); assert.equal(fs.existsSync(path), false); for (const bytes of ['{ "permissions": {} }', '{"permissions":{},"reviewer":{}}']) { writeFileSync(path, bytes); assert.equal(saveReviewer(t.global, undefined).ok, true); assert.equal(readFileSync(path, "utf8"), bytes); } } finally { t.cleanup(); } });
test("reviewer save refuses malformed JSON retaining bytes", () => { const t = temp(); mkdirSync(t.global, { recursive: true }); try { const path = join(t.global, "auto-permissions.json"); writeFileSync(path, "{broken"); assert.equal(saveReviewer(t.global, { provider: "p", id: "m" }).ok, false); assert.equal(readFileSync(path, "utf8"), "{broken"); } finally { t.cleanup(); } });
test("reviewer no-op clear validates existing config", () => { const t = temp(); mkdirSync(t.global, { recursive: true }); try { const path = join(t.global, "auto-permissions.json"); const bytes = JSON.stringify({ reviewer: { provider: "p" } }); writeFileSync(path, bytes); assert.equal(saveReviewer(t.global, undefined).ok, false); assert.equal(readFileSync(path, "utf8"), bytes); } finally { t.cleanup(); } });
test("reviewer save rejects blank pair without changing bytes", () => { const t = temp(); mkdirSync(t.global, { recursive: true }); try { const path = join(t.global, "auto-permissions.json"); const bytes = JSON.stringify({ permissions: {} }); writeFileSync(path, bytes); assert.equal(saveReviewer(t.global, { provider: " ", id: "m" }).ok, false); assert.equal(readFileSync(path, "utf8"), bytes); } finally { t.cleanup(); } });
test("reviewer write stages bytes before a partial write failure", () => { const t = temp(); mkdirSync(t.global, { recursive: true }); try { const path = join(t.global, "auto-permissions.json"); const original = JSON.stringify({ permissions: {}, reviewer: { provider: "old", model: "old-id" } }); writeFileSync(path, original); const beforeWrite = fs.writeFileSync; let injected = false; fs.writeFileSync = ((file: Parameters<typeof beforeWrite>[0], data: Parameters<typeof beforeWrite>[1], ...args: Parameters<typeof beforeWrite>[2][]) => { if (String(file) === path || String(file).startsWith(`${path}.`) || String(file).includes(`.${"auto-permissions.json"}.`)) { injected = true; beforeWrite(file, String(data).slice(0, 4), ...args); throw new Error("injected partial write"); } return beforeWrite(file, data, ...args); }) as typeof fs.writeFileSync; syncBuiltinESMExports(); try { assert.equal(saveReviewer(t.global, { provider: "new", id: "new-id" }).ok, false); } finally { fs.writeFileSync = beforeWrite; syncBuiltinESMExports(); } assert.equal(injected, true); assert.equal(readFileSync(path, "utf8"), original); const loaded = loadGlobalConfig(t.global); assert.equal(loaded.ok, true); if (loaded.ok) assert.deepEqual(loaded.reviewer.model, { provider: "old", id: "old-id" }); assert.deepEqual(fs.readdirSync(t.global), ["auto-permissions.json"]); } finally { t.cleanup(); } });
test("reviewer rename failures preserve existing and absent targets", () => { const t = temp(); mkdirSync(t.global, { recursive: true }); const original = fs.renameSync; try { const path = join(t.global, "auto-permissions.json"); const originalBytes = JSON.stringify({ permissions: {}, reviewer: { provider: "old", model: "old-id" } }); for (const exists of [true, false]) { if (exists) writeFileSync(path, originalBytes); else rmSync(path, { force: true }); fs.renameSync = (() => { throw new Error("rename denied"); }) as typeof fs.renameSync; syncBuiltinESMExports(); try { assert.equal(saveReviewer(t.global, { provider: "p", id: "m" }).ok, false); } finally { fs.renameSync = original; syncBuiltinESMExports(); } assert.equal(fs.existsSync(path), exists); if (exists) { assert.equal(readFileSync(path, "utf8"), originalBytes); const loaded = loadGlobalConfig(t.global); assert.equal(loaded.ok, true); if (loaded.ok) assert.deepEqual(loaded.reviewer.model, { provider: "old", id: "old-id" }); } assert.deepEqual(fs.readdirSync(t.global), exists ? ["auto-permissions.json"] : []); } } finally { fs.renameSync = original; syncBuiltinESMExports(); t.cleanup(); } });
test("reviewer save detects content changes during staging", () => { const t = temp(); mkdirSync(t.global, { recursive: true }); const path = join(t.global, "auto-permissions.json"); try { const initial = JSON.stringify({ permissions: {} }); writeFileSync(path, initial); const original = fs.readFileSync; let reads = 0; fs.readFileSync = ((file: Parameters<typeof original>[0], ...args: Parameters<typeof original>[1][]) => { if (String(file) === path && ++reads === 2) writeFileSync(path, "external"); return original(file as never, ...(args as [never])); }) as typeof fs.readFileSync; syncBuiltinESMExports(); try { const result = saveReviewer(t.global, { provider: "p", id: "m" }); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error, "config changed during save; refusing to overwrite"); } finally { fs.readFileSync = original; syncBuiltinESMExports(); } assert.equal(readFileSync(path, "utf8"), "external"); assert.deepEqual(fs.readdirSync(t.global), ["auto-permissions.json"]); } finally { t.cleanup(); } });
test("reviewer save detects target deletion or appearance", () => { for (const change of ["deletion", "appearance"]) { const t = temp(); mkdirSync(t.global, { recursive: true }); const path = join(t.global, "auto-permissions.json"); try { if (change === "deletion") writeFileSync(path, JSON.stringify({ permissions: {} })); const original = fs.readFileSync; let reads = 0; fs.readFileSync = ((file: Parameters<typeof original>[0], ...args: Parameters<typeof original>[1][]) => { if (String(file) === path && ++reads === 2) { if (change === "deletion") rmSync(path); else writeFileSync(path, "external"); } return original(file as never, ...(args as [never])); }) as typeof fs.readFileSync; syncBuiltinESMExports(); try { assert.equal(saveReviewer(t.global, { provider: "p", id: "m" }).ok, false); } finally { fs.readFileSync = original; syncBuiltinESMExports(); } assert.equal(fs.existsSync(path), change === "appearance"); if (change === "appearance") assert.equal(readFileSync(path, "utf8"), "external"); assert.deepEqual(fs.readdirSync(t.global), change === "appearance" ? ["auto-permissions.json"] : []); } finally { t.cleanup(); } } });
test("reviewer atomic replacement preserves restrictive mode and leaves no staging files", () => { const t = temp(); mkdirSync(t.global, { recursive: true }); try { const path = join(t.global, "auto-permissions.json"); writeFileSync(path, JSON.stringify({ permissions: {} })); chmodSync(path, 0o640); const previousUmask = process.umask(0o077); try { assert.equal(saveReviewer(t.global, { provider: "p", id: "m" }).ok, true); } finally { process.umask(previousUmask); } assert.equal(fs.statSync(path).mode & 0o777, 0o640); assert.deepEqual(fs.readdirSync(t.global), ["auto-permissions.json"]); } finally { t.cleanup(); } });
test("existing settings saver preserves reviewer pair", () => { const t = temp(); mkdirSync(t.global, { recursive: true }); try { const path = join(t.global, "auto-permissions.json"); writeFileSync(path, JSON.stringify({ permissions: {}, reviewer: { provider: "p", model: "m" } })); assert.equal(saveGlobalSettings(t.global, { enabled: false, reviewMode: "auto" }).ok, true); assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).reviewer, { provider: "p", model: "m" }); } finally { t.cleanup(); } });

test("strict nested configuration and values reject malformed inputs with source attribution", () => {
  const invalid = [null, [], { unknown: true }, { rules: [] },
    ...["reviewer", "reviewEvidence", "ui"].flatMap((key) => [ { [key]: null }, { [key]: [] }, { [key]: { unknown: true } } ]),
    { permissions: null }, { permissions: [] }, { permissions: { unknown: [] } }, { permissions: { allow: {} } },
    { permissions: { allow: [null] } }, { permissions: { allow: [""] } }, { permissions: { allow: [" "] } },
    { permissions: { allow: ["Bash("] } }, { permissions: { allow: ["Bash()"] } }, { permissions: { ask: ["Unknown(x)"] } },
    { permissions: { deny: ["Bash(a)b"] } }, { permissions: { deny: ["Read(x"] } }, { permissions: { defaultMode: "auto" } },
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
    mkdirSync(join(t.cwd, ".pi", "pi-auto-approval"), { recursive: true }); mkdirSync(t.global, { recursive: true });
    writeFileSync(join(t.global, "auto-permissions.json"), JSON.stringify({ enabled: false }));
    writeFileSync(projectConfigPath(t.cwd), "{broken");
    assert.equal(loadConfig(t.cwd, t.global).ok, false, "saved off still validates project");
  } finally { t.cleanup(); }
});

const PAST = new Date("2001-02-03T04:05:06Z");

test("ensureGlobalConfig creates exactly the approved seed once and never rewrites it", () => {
  const t = temp();
  try {
    const path = join(t.global, "auto-permissions.json");
    assert.deepEqual(config.ensureGlobalConfig(t.global), { created: true });
    assert.equal(readFileSync(path, "utf8"), JSON.stringify(SEED_CONFIG, null, 2) + "\n");
    fs.utimesSync(path, PAST, PAST);
    const bytes = readFileSync(path, "utf8");
    assert.deepEqual(config.ensureGlobalConfig(t.global), { created: false });
    assert.equal(readFileSync(path, "utf8"), bytes);
    assert.equal(fs.statSync(path).mtimeMs, PAST.getTime());
    assert.equal(fs.existsSync(projectConfigPath(t.cwd)), false, "startup seeding never creates project policy");
  } finally { t.cleanup(); }
});

test("ensureGlobalConfig leaves valid, invalid JSON, legacy, and directory targets byte and mtime identical", () => {
  const targets: Record<string, string> = {
    valid: JSON.stringify({ permissions: { allow: [], ask: [], deny: [] } }),
    invalidJson: "{broken",
    legacy: JSON.stringify({ rules: [{ tool: "bash", pattern: "^git status$", level: "allow" }] }),
  };
  for (const [name, bytes] of Object.entries(targets)) {
    const t = temp();
    try {
      mkdirSync(t.global, { recursive: true });
      const path = join(t.global, "auto-permissions.json");
      writeFileSync(path, bytes);
      fs.utimesSync(path, PAST, PAST);
      assert.deepEqual(config.ensureGlobalConfig(t.global), { created: false }, name);
      assert.equal(readFileSync(path, "utf8"), bytes, name);
      assert.equal(fs.statSync(path).mtimeMs, PAST.getTime(), name);
    } finally { t.cleanup(); }
  }
  const t = temp();
  try {
    const path = join(t.global, "auto-permissions.json");
    mkdirSync(path, { recursive: true });
    fs.utimesSync(path, PAST, PAST);
    assert.deepEqual(config.ensureGlobalConfig(t.global), { created: false }, "directory");
    assert.equal(fs.statSync(path).isDirectory(), true);
    assert.deepEqual(fs.readdirSync(path), []);
    assert.equal(fs.statSync(path).mtimeMs, PAST.getTime());
  } finally { t.cleanup(); }
});

test("ensureGlobalConfig uses an exclusive wx create with no existence precheck and keeps a competing file", () => {
  const t = temp();
  const path = join(t.global, "auto-permissions.json");
  const originalWrite = fs.writeFileSync;
  const originalExists = fs.existsSync;
  const writeFlags: unknown[] = [];
  let existsCalls = 0;
  fs.writeFileSync = ((file: Parameters<typeof originalWrite>[0], data: Parameters<typeof originalWrite>[1], options?: Parameters<typeof originalWrite>[2]) => {
    if (String(file) === path) {
      writeFlags.push((options as { flag?: unknown } | undefined)?.flag);
      originalWrite(path, "competitor", "utf8");
    }
    return originalWrite(file, data, options);
  }) as typeof fs.writeFileSync;
  fs.existsSync = ((file: Parameters<typeof originalExists>[0]) => { existsCalls++; return originalExists(file); }) as typeof fs.existsSync;
  syncBuiltinESMExports();
  try {
    mkdirSync(t.global, { recursive: true });
    assert.deepEqual(config.ensureGlobalConfig(t.global), { created: false });
  } finally {
    fs.writeFileSync = originalWrite;
    fs.existsSync = originalExists;
    syncBuiltinESMExports();
  }
  try {
    assert.deepEqual(writeFlags, ["wx"]);
    assert.equal(existsCalls, 0);
    assert.equal(readFileSync(path, "utf8"), "competitor");
  } finally { t.cleanup(); }
});

test("ensureGlobalConfig reports non-EEXIST filesystem failures as errors", () => {
  const t = temp();
  try {
    mkdirSync(join(t.root, "home"), { recursive: true });
    writeFileSync(join(t.root, "home", ".pi"), "not a directory");
    const result = config.ensureGlobalConfig(t.global);
    assert.equal(result.created, false);
    assert.ok("error" in result);
    assert.match(result.error, /ENOTDIR/);
    assert.equal(fs.existsSync(projectConfigPath(t.cwd)), false);
  } finally { t.cleanup(); }
});
