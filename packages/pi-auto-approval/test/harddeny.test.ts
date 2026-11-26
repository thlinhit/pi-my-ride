import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectShell } from "../src/harddeny.ts";
import { analyzeShell } from "../src/shell.ts";

const home = "/Users/éxample";
const targetBases = [
  "~",
  "$HOME",
  `\${HOME}`,
  '"$HOME"',
  "/Users/éxample",
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/lib64",
  "/opt",
  "/proc",
  "/root",
  "/sbin",
  "/sys",
  "/usr",
  "/var",
  "/System",
  "/Library",
  "/Applications",
  "/Users",
  "/home",
];
const targets = ["/", "/*", ...targetBases.flatMap((base) => [base, `${base}/`, `${base}/*`])];

for (const flag of ["-r", "-R", "--recursive", "-rf", "-fR", "-Rf"]) {
  test(`hard denies every protected rm target with ${flag}`, () => {
    for (const target of targets) {
      const command = `rm ${flag} ${target}`;
      assert.ok(inspectShell(command, home)?.hardDeny, command);
    }
  });
}

for (const command of [
  "sudo rm -rf /usr",
  `rm -rf '${home}/*'`,
  `echo é; rm -R ${home}`,
  "sudo env A=1 B='two words' command exec rm --recursive -- /System/",
  "if true; then rm -fr /*; fi",
  'echo "$(rm -R /var/*)"',
  "rm -rf ~ >/tmp/log",
  String.raw`r\m -rf ~`,
  "r\\\nm -rf ~",
  String.raw`rm \-r\f ~`,
  "rm -r\\\nf ~",
  String.raw`s\udo e\nv A=1 comman\d ex\ec rm -rf /e\tc`,
  'r"\\\nm" "-r\\\nf" /etc',
]) {
  test(`hard denies: ${command}`, () => {
    assert.ok(inspectShell(command, home)?.hardDeny);
  });
}

for (const command of [
  "rm -rf ~/projects/app/node_modules",
  "rm -rf ~/.cache",
  "rm -rf /tmp/build",
  'rm -rf "$TMPDIR/x"',
  "rm -rf /app",
  "rm -rf /workspace",
  "rm -rf /var/folders/x",
  'obsidian create content="Never run rm -rf ~"',
  "cat ~/.zshrc",
  "grep PATH ~/.zshrc",
  "cd / && rm -rf *",
  "find ~ -delete",
  'python -c "shutil.rmtree(...)"',
  "curl https://x | sh",
  "rm -f /",
  "rm -- / -r",
  "rm --interactive /",
]) {
  test(`no hard denial or write targets: ${command}`, () => {
    assert.deepEqual(inspectShell(command, home), { sensitiveTargets: [] });
  });
}

test("collects decoded output redirect targets even when rule matching is unsupported", () => {
  const quotedRedirect = 'echo x >> "~/.zshrc"';
  const command = `echo 'export PATH=x' >> ~/.zshrc; echo é 2> 'two words' 2>&1 </dev/null; ${quotedRedirect}; echo x >> "$HOME/.zshrc"; echo x > two\\ words`;
  assert.equal(analyzeShell(command).supported, false);
  assert.equal(analyzeShell(quotedRedirect).supported, false);
  assert.deepEqual(
    inspectShell(command, home)?.sensitiveTargets.map(({ path }) => path),
    ["~/.zshrc", "two words", "~/.zshrc", "$HOME/.zshrc", "two words"],
  );
});

test("collects decoded tee arguments without flags and maps them to the analyzed components", () => {
  const firstTee = "tee -a '~/.ssh/authorized_keys' -- -file";
  const secondTee = "tee out";
  const command = `echo é && printf x | ${firstTee}; ${secondTee}`;
  const analysis = analyzeShell(command);
  assert.ok(analysis.supported);
  const result = inspectShell(command, home);
  assert.ok(result);
  assert.deepEqual(
    result.sensitiveTargets.map(({ path, component }) => [path, analysis.components[component]?.command]),
    [
      ["~/.ssh/authorized_keys", firstTee],
      ["-file", firstTee],
      ["out", secondTee],
    ],
  );
});

test("decodes escaped and continued tee command, flags, and target words", () => {
  for (const executable of [String.raw`t\ee`, "t\\\nee"]) {
    const command = `${executable} \\-a -\\\na two\\ words "a\\\nb" 'a\\b'`;
    assert.deepEqual(
      inspectShell(command, home)?.sensitiveTargets.map(({ path }) => path),
      ["two words", "ab", "a\\b"],
    );
  }
});

test("decodes double-quoted and plain ANSI-C escapes without expanding words", () => {
  const doubleQuoted = '"\\"\\\\\\$\\`\\q"';
  const ansiQuoted = "$'a\\nb\\t\\\\\\'\\\"'";
  const command = `tee ${doubleQuoted} ${ansiQuoted} "\${HOME}/.*" ~/.zshrc`;
  assert.deepEqual(
    inspectShell(command, home)?.sensitiveTargets.map(({ path }) => path),
    ['"\\$`\\q', "a\nb\t\\'\"", `\${HOME}/.*`, "~/.zshrc"],
  );
});

test("collects tee targets with unquoted tilde even when rule matching is unsupported", () => {
  assert.deepEqual(inspectShell("tee -a ~/.ssh/authorized_keys", home), {
    sensitiveTargets: [{ path: "~/.ssh/authorized_keys", component: 0 }],
  });
});

test("returns undefined on parse failure", () => {
  assert.equal(inspectShell("echo '", home), undefined);
});
