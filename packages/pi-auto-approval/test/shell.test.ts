import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeShell } from "../src/shell.ts";

test("extracts exact simple command source spans", () => {
  const result = analyzeShell("echo 'hello';printf 'abc'");
  assert.equal(result.supported, true);
  if (result.supported) assert.deepEqual(result.components.map(c => c.command), ["echo 'hello'", "printf 'abc'"]);
});

for (const [source, commands] of [
  ["echo '😀é';pwd", ["echo '😀é'", "pwd"]],
  ["a && b | c || d & e", ["a", "b", "c", "d", "e"]],
  ["echo a\\;b;echo a\\|b", ["echo a\\;b", "echo a\\|b"]],
  ["# hello\necho 'a;b' #tail\npwd", ["echo 'a;b'", "pwd"]],
  ["echo a\\\nb;pwd", ["echo a\\\nb", "pwd"]],
  ['echo "literal;|&"', ['echo "literal;|&"']],
] as const) test(`source excerpts: ${JSON.stringify(source)}`, () => {
  const result = analyzeShell(source);
  assert.equal(result.supported, true);
  if (!result.supported) return;
  assert.deepEqual(result.components.map(c => c.command), commands);
  for (const c of result.components) assert.equal(source.slice(c.start, c.end), c.command);
});

for (const source of [
  "echo ok\r\npwd", "echo ok &&", "echo ok |", "echo 'unfinished", "echo ok; ;pwd", "echo $(pwd)", "echo `pwd`", "cat <(pwd)",
  "for i in a; do echo $i; done", "f() { pwd; }", "(pwd)", "{ pwd; }", "! pwd", "((1+1))", "[[ -f x ]]",
  "if true; then pwd; fi", "echo x > out", "cat <<EOF\nx\nEOF", "cat <<< x", ">out", "x=1 pwd", "echo $HOME",
  "echo *.ts", "echo ~", "echo {a,b}", "echo $'abc'", 'echo $"abc"', "a |& b", "coproc pwd", "", "#only comment",
]) test(`fails closed: ${JSON.stringify(source)}`, () => assert.equal(analyzeShell(source).supported, false));

test("distinguishes reviewable syntax from invalid or parser-ambiguous input", () => {
  for (const source of ["echo $HOME", "x=1", "echo x >out", "echo $(pwd)"]) {
    const result = analyzeShell(source);
    assert.equal(result.supported, false);
    if (!result.supported) assert.equal(result.reviewable, true);
  }
  for (const source of ["echo &&", "echo '", "", "# comment", "echo\r\npwd", "echo\0x", "echo \ud800"]) {
    const result = analyzeShell(source);
    assert.equal(result.supported, false);
    if (!result.supported) assert.equal(result.reviewable, false);
  }
});

test("mixed expressions retain all enclosing relationships", () => {
  const result = analyzeShell("a && b | c || d & e");
  assert.equal(result.supported, true);
  if (!result.supported) return;
  const b = result.components[1]!;
  assert.deepEqual(b.context.map(r => [r.kind, r.operator, r.side]), [
    ["list", undefined, undefined], ["background", "&", undefined],
    ["binary", "||", "left"], ["binary", "&&", "right"], ["binary", "|", "left"],
  ]);
});
