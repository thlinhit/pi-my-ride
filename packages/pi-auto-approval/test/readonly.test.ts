import assert from "node:assert/strict";
import test from "node:test";
import { isReadOnlyComponent } from "../src/readonly.ts";
import { analyzeShell } from "../src/shell.ts";

for (const command of ["date", "date +%y%m%d", "echo hi"]) {
  test(`read-only: ${command}`, () => assert.equal(isReadOnlyComponent(command), true));
}

for (const command of ["date 0101000026", "date -s x", "date +%y%m%d extra"]) {
  test(`not read-only: ${command}`, () => assert.equal(isReadOnlyComponent(command), false));
}

test("redirected echo is unsupported", () => {
  assert.equal(analyzeShell("echo hi > f").supported, false);
  assert.equal(isReadOnlyComponent("echo hi > f"), false);
});

for (const command of [
  "cd DIR", "pwd", "ls -la", "cat x", "nl -ba SKILL.md", "head -20 x", "tail x", "wc -l x",
  "grep -n -iE 'a|b' -r examples references", "rg foo .", "find . -name 'x'",
  "sed -n '1,80p;140,260p' SKILL.md", "sed -n '1,$p' x", 'sed -n "1p" x', "sed -n '1p' 'a b'", "c'a't x",
]) test(`read-only: ${command}`, () => assert.equal(isReadOnlyComponent(command), true));

for (const command of [
  "sed -n -Ei 1p f", "sed -n -si 1p f", "sed -nf s f", "sed -ne 1p f",
  "sed -i '1p' x", "sed -n -i.bak '1p' x", "sed -n --in-place '1p' x", "sed -n '1w out' x", "sed -n 'e cmd' x",
  "sed '1p' x", "sed -n -e '1p' x", "sed -n -f script x", "sed -n --expression='1p' x", "sed -n --file=script x", "sed -n", "sed -n '' x",
  "find . -delete", "find . -exec rm {} \\;", "find . -execdir x", "find . -ok x", "find . -okdir x",
  "find . -fprint out", "find . -fprint0 out", "find . -fprintf out x", "find . -fls out",
  "rg --pre x foo", "rg --pre=x foo", "rg --pre-glob='*' foo", "rg --pre-glob foo",
  "rm x", "/bin/cat x", "", "cat 'x", "cat x\\ y", "cat x | tee y", "cat $HOME", "cat `pwd`", "cat\u00a0x", "cat\r x", "cat\0x",
]) test(`not read-only: ${command}`, () => assert.equal(isReadOnlyComponent(command), false));
