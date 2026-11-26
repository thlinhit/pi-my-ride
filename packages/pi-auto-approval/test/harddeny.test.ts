import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectShell } from "../src/harddeny.ts";

const home = "/Users/éxample";

for (const command of [
  "rm -rf ~",
  "rm -rf ~/",
  "rm -rf ~/*",
  "rm -rf /",
  "rm -r /etc",
  "sudo rm -rf /usr",
  'rm -rf "$HOME"',
  `rm -rf \${HOME}`,
  `rm -rf '${home}/*'`,
  `echo é; rm -R ${home}`,
  "sudo env A=1 B='two words' command exec rm --recursive -- /System/",
  "if true; then rm -fr /*; fi",
  'echo "$(rm -R /var/*)"',
  "rm -rf ~ >/tmp/log",
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

test("collects raw output redirect targets even when rule matching is unsupported", () => {
  assert.deepEqual(inspectShell("echo 'export PATH=x' >> ~/.zshrc; echo é 2> 'two words' 2>&1 </dev/null", home), {
    sensitiveTargets: [
      { path: "~/.zshrc", component: 0 },
      { path: "'two words'", component: 1 },
    ],
  });
});

test("collects tee arguments without flags, in supported component order", () => {
  assert.deepEqual(inspectShell("echo é && printf x | tee -a '.ssh/authorized_keys' -- -file; tee out", home), {
    sensitiveTargets: [
      { path: "'.ssh/authorized_keys'", component: 2 },
      { path: "-file", component: 2 },
      { path: "out", component: 3 },
    ],
  });
});

test("collects tee targets with unquoted tilde even when rule matching is unsupported", () => {
  assert.deepEqual(inspectShell("tee -a ~/.ssh/authorized_keys", home), {
    sensitiveTargets: [{ path: "~/.ssh/authorized_keys", component: 0 }],
  });
});

test("returns undefined on parse failure", () => {
  assert.equal(inspectShell("echo '", home), undefined);
});
