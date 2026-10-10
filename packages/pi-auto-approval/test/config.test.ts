import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, loadConfig, CONFIG_FILENAME } from "../src/config.ts";

function errorOf(raw: unknown): string {
  const r = parseConfig(raw, "cfg.json");
  if (r.ok) assert.fail("expected invalid config");
  return r.error;
}

function rulesOf(raw: unknown) {
  const r = parseConfig(raw, "cfg.json");
  if (!r.ok) assert.fail(r.error);
  return r.rules;
}

const validRule = { pattern: "git\\s+push", level: "guarded", label: "git push" };

describe("parseConfig: invalid shapes block", () => {
  test("root null, array, or string is rejected", () => {
    assert.match(errorOf(null), /cfg\.json/);
    assert.match(errorOf([]), /cfg\.json/);
    assert.match(errorOf("rules"), /cfg\.json/);
  });

  test("missing or non-array rules is rejected", () => {
    assert.match(errorOf({}), /rules/);
    assert.match(errorOf({ rules: {} }), /rules/);
    assert.match(errorOf({ rules: null }), /rules/);
  });

  test("non-object rule is rejected with its index", () => {
    assert.match(errorOf({ rules: [null] }), /rules\[0\]/);
    assert.match(errorOf({ rules: [[]] }), /rules\[0\]/);
    assert.match(errorOf({ rules: ["x"] }), /rules\[0\]/);
  });

  test("pattern must be a non-empty, non-whitespace string", () => {
    assert.match(errorOf({ rules: [{ ...validRule, pattern: undefined }] }), /pattern/);
    assert.match(errorOf({ rules: [{ ...validRule, pattern: "" }] }), /pattern/);
    assert.match(errorOf({ rules: [{ ...validRule, pattern: "   " }] }), /pattern/);
    assert.match(errorOf({ rules: [{ ...validRule, pattern: 42 }] }), /pattern/);
  });

  test("bad regex is rejected", () => {
    assert.match(errorOf({ rules: [{ ...validRule, pattern: "(" }] }), /rules\[0\]/);
  });

  test("flags must be a string of allowed flags without g or y", () => {
    assert.match(errorOf({ rules: [{ ...validRule, flags: 1 }] }), /flags/);
    assert.match(errorOf({ rules: [{ ...validRule, flags: "g" }] }), /flags/);
    assert.match(errorOf({ rules: [{ ...validRule, flags: "iy" }] }), /flags/);
    assert.match(errorOf({ rules: [{ ...validRule, flags: "x" }] }), /flags/);
    assert.match(errorOf({ rules: [{ ...validRule, flags: "ii" }] }), /rules\[0\]/);
  });

  test("level must be guarded or convention", () => {
    assert.match(errorOf({ rules: [{ ...validRule, level: "allow" }] }), /level/);
    assert.match(errorOf({ rules: [{ ...validRule, level: undefined }] }), /level/);
  });

  test("label must be a non-empty, non-whitespace string", () => {
    assert.match(errorOf({ rules: [{ ...validRule, label: undefined }] }), /label/);
    assert.match(errorOf({ rules: [{ ...validRule, label: " \t" }] }), /label/);
  });

  test("convention requires a non-whitespace message", () => {
    const base = { pattern: "^terraform", level: "convention", label: "tf" };
    assert.match(errorOf({ rules: [base] }), /message/);
    assert.match(errorOf({ rules: [{ ...base, message: "" }] }), /message/);
    assert.match(errorOf({ rules: [{ ...base, message: "  " }] }), /message/);
  });

  test("message, when supplied, must be a non-whitespace string", () => {
    assert.match(errorOf({ rules: [{ ...validRule, message: "  " }] }), /message/);
    assert.match(errorOf({ rules: [{ ...validRule, message: 5 }] }), /message/);
  });

  test("an invalid later rule blocks even when an earlier rule is valid", () => {
    assert.match(errorOf({ rules: [validRule, { ...validRule, level: "nope" }] }), /rules\[1\]/);
  });
});

describe("parseConfig: valid configs", () => {
  test("empty rules array is valid and yields no rules", () => {
    assert.deepEqual(rulesOf({ rules: [] }), []);
  });

  test("unknown keys are ignored at root and rule level", () => {
    const rules = rulesOf({ extra: true, rules: [{ ...validRule, note: "x" }] });
    assert.equal(rules.length, 1);
    assert.equal(rules[0]!.label, "git push");
  });

  test("guarded rule without message is valid; message kept when supplied", () => {
    const [a, b] = rulesOf({
      rules: [validRule, { ...validRule, message: "ask first" }],
    });
    assert.equal(a!.message, undefined);
    assert.equal(b!.message, "ask first");
  });

  test("flags i is honoured in the compiled pattern", () => {
    const [rule] = rulesOf({ rules: [{ ...validRule, pattern: "^GIT", flags: "i" }] });
    assert.equal(rule!.pattern.test("git status"), true);
    assert.equal(rule!.pattern.global, false);
    assert.equal(rule!.pattern.sticky, false);
  });

  test("convention rule with message is valid", () => {
    const [rule] = rulesOf({
      rules: [{ pattern: "^terraform", level: "convention", label: "tf", message: "Use CI" }],
    });
    assert.equal(rule!.level, "convention");
    assert.equal(rule!.message, "Use CI");
  });

  test("original strings are preserved, not trimmed", () => {
    const [rule] = rulesOf({ rules: [{ ...validRule, label: " git push " }] });
    assert.equal(rule!.label, " git push ");
  });
});

describe("loadConfig: precedence and failure handling", () => {
  function setup() {
    const root = mkdtempSync(join(tmpdir(), "aa-config-"));
    const cwd = join(root, "project");
    const globalDir = join(root, "global");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    mkdirSync(globalDir, { recursive: true });
    return {
      cwd,
      globalDir,
      projectFile: join(cwd, ".pi", CONFIG_FILENAME),
      globalFile: join(globalDir, CONFIG_FILENAME),
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  }

  test("no files -> ok with no rules and null source", () => {
    const t = setup();
    try {
      assert.deepEqual(loadConfig(t.cwd, t.globalDir), { ok: true, rules: [], source: null });
    } finally {
      t.cleanup();
    }
  });

  test("global file used when project file is absent", () => {
    const t = setup();
    try {
      writeFileSync(t.globalFile, JSON.stringify({ rules: [validRule] }));
      const r = loadConfig(t.cwd, t.globalDir);
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.equal(r.source, t.globalFile);
      assert.equal(r.rules.length, 1);
    } finally {
      t.cleanup();
    }
  });

  test("project file wins over global with no merging", () => {
    const t = setup();
    try {
      writeFileSync(t.globalFile, JSON.stringify({ rules: [validRule] }));
      writeFileSync(t.projectFile, JSON.stringify({ rules: [] }));
      const r = loadConfig(t.cwd, t.globalDir);
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.equal(r.source, t.projectFile);
      assert.deepEqual(r.rules, []);
    } finally {
      t.cleanup();
    }
  });

  test("invalid project file does not fall back to global", () => {
    const t = setup();
    try {
      writeFileSync(t.globalFile, JSON.stringify({ rules: [validRule] }));
      writeFileSync(t.projectFile, "{ not json");
      const r = loadConfig(t.cwd, t.globalDir);
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.match(r.error, new RegExp(t.projectFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      t.cleanup();
    }
  });

  test("invalid schema in global file blocks", () => {
    const t = setup();
    try {
      writeFileSync(t.globalFile, JSON.stringify({ rules: "nope" }));
      const r = loadConfig(t.cwd, t.globalDir);
      assert.equal(r.ok, false);
    } finally {
      t.cleanup();
    }
  });

  test("project path that is a directory (EISDIR) blocks, does not fall back", () => {
    const t = setup();
    try {
      mkdirSync(t.projectFile);
      writeFileSync(t.globalFile, JSON.stringify({ rules: [validRule] }));
      const r = loadConfig(t.cwd, t.globalDir);
      assert.equal(r.ok, false);
    } finally {
      t.cleanup();
    }
  });

  test("project .pi that is a file (ENOTDIR) blocks, does not fall back", () => {
    const t = setup();
    try {
      rmSync(join(t.cwd, ".pi"), { recursive: true, force: true });
      writeFileSync(join(t.cwd, ".pi"), "not a dir");
      writeFileSync(t.globalFile, JSON.stringify({ rules: [validRule] }));
      const r = loadConfig(t.cwd, t.globalDir);
      assert.equal(r.ok, false);
    } finally {
      t.cleanup();
    }
  });
});
