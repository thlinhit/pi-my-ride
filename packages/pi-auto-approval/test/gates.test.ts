import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isSuspiciousAllow } from "../src/gates.ts";

test("suspicious allow detection is conservative, not a shell-safety proof", () => {
  for (const command of ["a;b", "a&&b", "a||b", "a|b", "a&", "a\nb", "a\r\nb", "$(x)", "`x`", "<(x)", ">(x)", 'echo "a; b"', "cmd 2>&1"]) assert.equal(isSuspiciousAllow(command), true, command);
  for (const command of ["git status", "ls -la", "echo hello"]) assert.equal(isSuspiciousAllow(command), false, command);
});
