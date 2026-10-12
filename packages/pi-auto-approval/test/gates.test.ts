import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { matchRule, isSuspiciousAllow } from "../src/gates.ts";
import type { Rule } from "../src/config.ts";

const rule = (level: Rule["level"], scope: Rule["scope"], label: string): Rule => ({ pattern: /cmd/i, level, scope, source: `${scope}.json`, label });

describe("matchRule", () => {
  test("prioritizes deny, then ask, then allow across scope and order", () => {
    const deny = rule("deny", "project", "deny");
    const ask = rule("ask", "global", "ask");
    const allow = rule("allow", "global", "allow");
    for (const rules of [[allow, ask, deny], [deny, allow, ask], [ask, deny, allow]]) assert.equal(matchRule("cmd", rules, true), deny);
    assert.equal(matchRule("cmd", [allow, ask], true), ask);
    assert.equal(matchRule("cmd", [allow], true), allow);
  });
  test("uses first global match before project at the winning level", () => {
    const project = rule("deny", "project", "project");
    const global1 = rule("deny", "global", "global1");
    const global2 = rule("deny", "global", "global2");
    assert.equal(matchRule("cmd", [project, global1, global2], true), global1);
  });
  test("ignores untrusted project allows but retains other actions and global allows", () => {
    const projectAllow = rule("allow", "project", "project allow");
    const globalAllow = rule("allow", "global", "global allow");
    assert.equal(matchRule("cmd", [projectAllow], false), undefined);
    assert.equal(matchRule("cmd", [projectAllow, globalAllow], false), globalAllow);
    assert.equal(matchRule("cmd", [rule("ask", "project", "ask")], false)?.level, "ask");
    assert.equal(matchRule("cmd", [projectAllow], true), projectAllow);
    assert.equal(matchRule("none", [], false), undefined);
  });
});

test("suspicious allow detection is conservative, not a shell-safety proof", () => {
  for (const command of ["a;b", "a&&b", "a||b", "a|b", "a&", "a\nb", "a\r\nb", "$(x)", "`x`", "<(x)", ">(x)", 'echo "a; b"', "cmd 2>&1"]) assert.equal(isSuspiciousAllow(command), true, command);
  for (const command of ["git status", "ls -la", "echo hello"]) assert.equal(isSuspiciousAllow(command), false, command);
});
