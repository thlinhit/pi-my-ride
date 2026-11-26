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
  "echo *.ts", "echo ~", "echo {a,b}", 'echo $"abc"', "a |& b", "coproc pwd", "", "#only comment",
]) test(`fails closed: ${JSON.stringify(source)}`, () => assert.equal(analyzeShell(source).supported, false));

for (const [name, source, words] of [
  ["unquoted words", "echo first second", [["echo", "first", "second"]]],
  ["single-quoted words", "echo 'draft \\note' ''", [["echo", "draft \\note", ""]]],
  ["double-quoted spaces and escapes", 'echo "a b \\" \\\\ \\$ \\` \\q"', [["echo", 'a b " \\ $ ` \\q']]],
  ["unquoted escapes", String.raw`echo draft\ note a\*b`, [["echo", "draft note", "a*b"]]],
  ["plain ANSI-C escapes", String.raw`printf $'l1\nl2' $'a\'b' $'\t\\\"'`, [["printf", "l1\nl2", "a'b", '\t\\"']]],
  ["line continuations", 'echo a\\\nb "c\\\nd" \\\n e', [["echo", "ab", "cd", "e"]]],
  ["mixed quote concatenation", 'preview path="1. Inbox/Work/"a.md', [["preview", "path=1. Inbox/Work/a.md"]]],
  [
    "Obsidian arguments in source order",
    String.raw`obsidian vault=X create path="1. Inbox/Work/a.md" content=$'l1\nl2'`,
    [["obsidian", "vault=X", "create", "path=1. Inbox/Work/a.md", "content=l1\nl2"]],
  ],
  [
    "words separated by component",
    'a x && b "y z"',
    [
      ["a", "x"],
      ["b", "y z"],
    ],
  ],
] as const)
  test(`unquotes ${name}`, () => {
    const result = analyzeShell(source);
    assert.equal(result.supported, true);
    assert.deepEqual(
      result.components.map((c) => c.words),
      words,
    );
  });

test("leading shell assignments retain the unsupported shape", () => {
  assert.deepEqual(analyzeShell("NAME=value echo first"), {
    supported: false,
    reviewable: true,
    reason: "Shell syntax requires whole-command review",
  });
});

test("ANSI-C quotes with plain escapes preserve exact source", () => {
  const source = String.raw`printf $'é/\n\t\\x\'\"'`;
  const result = analyzeShell(source);
  assert.equal(result.supported, true);
  if (result.supported) assert.equal(result.components[0]?.command, source);
});

test("ANSI-C quotes with other escapes require whole-command review", () => {
  for (const sequence of ["\\x2drf", "\\u002f", "\\U0000002f", "\\057", "\\cA", "\\e", "\\r", "\\a"]) {
    const result = analyzeShell(`printf $'${sequence}'`);
    assert.equal(result.supported, false, sequence);
    if (!result.supported) assert.equal(result.reviewable, true, sequence);
  }
});

test("ANSI-C quote ending in a lone backslash is unsupported", () => {
  assert.equal(analyzeShell("printf $'abc\\").supported, false);
});

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
