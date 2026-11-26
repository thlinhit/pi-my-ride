import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { foldPath, isPathInsideOrEqual, resolvePathForPolicy } from "../src/paths.ts";

function symlinkFixture(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-auto-approval-paths-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const target = join(cwd, "target");
  mkdirSync(target);
  symlinkSync(target, join(cwd, "alias"), "dir");
  return { cwd, target: realpathSync.native(target) };
}

test("resolves an existing file through a symlinked directory", (t) => {
  const { cwd, target } = symlinkFixture(t);
  writeFileSync(join(target, "file"), "");
  assert.equal(resolvePathForPolicy(join(cwd, "alias", "file")), join(target, "file"));
});

test("resolves missing suffixes through a symlinked directory", (t) => {
  const { cwd, target } = symlinkFixture(t);
  assert.equal(resolvePathForPolicy(join("alias", "file"), cwd), join(target, "file"));
  assert.equal(resolvePathForPolicy(join("alias", "new", "file"), cwd), join(target, "new", "file"));
});

test("folds case and NFC/NFD variants for equality and containment", () => {
  const directory = join("a", "Café");
  const variant = join("A", "CAFÉ").normalize("NFD");
  assert.equal(foldPath(variant), foldPath(directory));
  assert.equal(isPathInsideOrEqual(variant, directory), true);
  assert.equal(isPathInsideOrEqual(join(variant, "file"), directory), true);
});

test("rejects sibling directories with a shared prefix", () => {
  assert.equal(isPathInsideOrEqual(join("a", "pi-x", "file"), join("a", "pi")), false);
});
