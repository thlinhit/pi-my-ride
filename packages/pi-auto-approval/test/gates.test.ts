import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { matchRule } from "../src/gates.ts";
import type { Rule } from "../src/config.ts";

const guardedPush: Rule = { pattern: /\bgit\s+push\b/, level: "guarded", label: "git push" };
const anyGit: Rule = { pattern: /\bgit\b/, level: "convention", label: "git", message: "use wrapper" };

describe("matchRule", () => {
  test("no rule matches -> undefined", () => {
    assert.equal(matchRule("ls -la", [guardedPush]), undefined);
    assert.equal(matchRule("ls", []), undefined);
  });

  test("first matching rule wins when several overlap", () => {
    assert.equal(matchRule("git push origin main", [guardedPush, anyGit]), guardedPush);
    assert.equal(matchRule("git push origin main", [anyGit, guardedPush]), anyGit);
  });

  test("matches raw text only, without splitting on && or ;", () => {
    assert.equal(matchRule("echo ok && git push", [guardedPush]), guardedPush);
    assert.equal(matchRule("git status; ls", [guardedPush]), undefined);
  });

  test("case-insensitive flag is honoured", () => {
    const rule: Rule = { pattern: /^TERRAFORM/i, level: "guarded", label: "tf" };
    assert.equal(matchRule("terraform apply", [rule]), rule);
  });

  test("repeated calls are stable (no lastIndex drift)", () => {
    const rules = [guardedPush];
    for (let i = 0; i < 5; i++) {
      assert.equal(matchRule("git push", rules), guardedPush);
    }
  });
});
