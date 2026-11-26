import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import {
  allowWordsMatch,
  matchPermission,
  matchPermissionExact,
  parsePermissionRule,
  ruleMatches,
  tokenizeAllowRule,
} from "../src/rules.ts";
import type { PermissionRule } from "../src/rules.ts";

function parse(
  raw: string,
  level: PermissionRule["level"] = "allow",
  scope: PermissionRule["scope"] = "global",
): PermissionRule {
  const result = parsePermissionRule(raw, level, `${scope}.json`, scope, `${scope}.permissions[0]`);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
const call = (toolName: string, input: unknown = {}): { toolName: string; input: unknown } => ({ toolName, input });

test("exact Bash matching does not split quoted delimiters and retains precedence and trust", () => {
  const deny = parse("Bash(rm *)", "deny");
  const ask = parse("Bash(echo *)", "ask");
  const allow = parse("Bash(*)");
  const quoted = call("bash", { command: "echo 'x;rm file;z'" });
  assert.equal(matchPermissionExact(quoted, "/tmp", [allow, deny, ask], true), ask);
  assert.equal(matchPermissionExact(call("bash", { command: "rm file" }), "/tmp", [allow, deny], true), deny);
  assert.equal(matchPermissionExact(quoted, "/tmp", [parse("Bash(*)", "allow", "project")], false), undefined);
  assert.equal(matchPermissionExact(quoted, "/tmp", [parse("Bash(*)", "ask", "project"), ask], true), ask);
});

describe("word-based allow rules", () => {
  function matches(specifier: string, command: readonly string[]): boolean {
    const rule = tokenizeAllowRule(specifier);
    assert.ok(rule.ok);
    return allowWordsMatch(rule.words, command);
  }

  const obsidian = 'obsidian vault=X create path="1. Inbox/Work/*" *';
  const path = "path=1. Inbox/Work/a.md";
  const scenarios = [
    ["allows multiline content", [path, "content=l1\nl2"], true],
    ["rejects a nested path", ["path=1. Inbox/Work/sub/a.md"], false],
    ["rejects another directory", ["path=1. Inbox/Personal/a.md"], false],
    ["rejects a repeated path", [path, "path=Secrets/x.md"], false],
    ["rejects a traversal path", ["path=1. Inbox/Work/../../Private/x.md"], false],
    ["allows slash content after the path", [path, "content=see a/b/c"], true],
  ] as const;
  for (const [name, args, expected] of scenarios) {
    test(name, () => assert.equal(matches(obsidian, ["obsidian", "vault=X", "create", ...args]), expected));
  }

  test("distinguishes single and double stars inside a word", () => {
    assert.equal(matches('content="*"', ["content=a/b"]), false);
    assert.equal(matches("content='**'", ["content=a/b"]), true);
    assert.equal(matches("cat src/**", ["cat", "src/a/b.ts"]), true);
    assert.equal(matches("cat src/**", ["cat", "src/a/../b.ts"]), false);
  });

  test("rejects duplicate double-dash keys", () => {
    assert.equal(matches("cmd --path=a *", ["cmd", "--path=a"]), true);
    assert.equal(matches("cmd --path=a *", ["cmd", "--path=a", "--path=b"]), false);
  });

  test("preserves exact matches and distinguishes whole-word stars", () => {
    assert.equal(matches("cat src/*", ["cat", "src/a/b.ts"]), false);
    assert.equal(matches("git diff*", ["git", "diff", "--stat"]), false);
    assert.equal(matches("git status", ["git", "status"]), true);
    assert.equal(matches("git status", ["git", "status", "--short"]), false);
    assert.equal(matches("git diff *", ["git", "diff", "--stat"]), true);
    assert.equal(matches("git diff *", ["git", "diff"]), true);
    assert.equal(matches("cmd * a * b", ["cmd", "x", "a", "y", "b"]), true);
  });

  test("removes both quote styles and rejects unterminated and blank specifiers", () => {
    assert.deepEqual(tokenizeAllowRule(` cmd\tpre' x'" y" '' `), { ok: true, words: ["cmd", "pre x y", ""] });
    assert.deepEqual(tokenizeAllowRule('cmd "unterminated'), { ok: false });
    assert.deepEqual(tokenizeAllowRule("cmd 'unterminated"), { ok: false });
    assert.deepEqual(tokenizeAllowRule(" \t"), { ok: false });
  });
});

describe("permission grammar", () => {
  test("maps builtin aliases case-insensitively and custom tool names exactly", () => {
    assert.equal(ruleMatches(parse("bAsH(git status)"), call("bash", { command: "git status" }), "/tmp"), true);
    assert.equal(ruleMatches(parse("Edit(*)"), call("write", { path: "x" }), "/tmp"), true);
    assert.equal(ruleMatches(parse("Edit(*)"), call("read", { path: "x" }), "/tmp"), false);
    assert.equal(ruleMatches(parse("CronCreate"), call("CronCreate"), "/tmp"), true);
    assert.equal(ruleMatches(parse("CronCreate"), call("croncreate"), "/tmp"), false);
  });

  test("rejects blank and malformed rules and accepts literal nested parentheses", () => {
    for (const raw of [
      "",
      "   ",
      "Bash()",
      "Bash( )",
      "Bash(git status",
      "Bash git)",
      "Bash(git)extra",
      "WebFetch(domain:*)",
    ]) {
      assert.equal(parsePermissionRule(raw, "allow", "x", "global", "where").ok, false, raw);
    }
    assert.equal(parse("Bash(echo (ok))").specifier, "echo (ok)");
    assert.match(
      parsePermissionRule("", "allow", "x", "global", "where").ok
        ? ""
        : (parsePermissionRule("", "allow", "x", "global", "where") as { error: string }).error,
      /where/,
    );
  });
});

test("ask matches the lexical and resolved paths through a symlink", (t) => {
  const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "permissions-link-")));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, "real"));
  symlinkSync("real", join(cwd, "link"));
  const edit = call("edit", { path: "./link/x.md" });

  assert.equal(ruleMatches(parse("Edit(./real/**)", "ask"), edit, cwd), true);
  assert.equal(ruleMatches(parse("Edit(./link/**)", "ask"), edit, cwd), true);
});

test("allow matches the symlink target but not the link directory", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "permissions-link-allow-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, "real"));
  symlinkSync("real", join(cwd, "link"));
  const edit = call("edit", { path: "./link/x.md" });

  assert.equal(ruleMatches(parse("Edit(./real/**)"), edit, cwd), true);
  assert.equal(ruleMatches(parse("Edit(./link/**)"), edit, cwd), false);
});

test("parent-relative rules use the lexical parent of a symlinked cwd", (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "permissions-linked-parent-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "lexical", "project");
  mkdirSync(join(root, "lexical", "docs"), { recursive: true });
  mkdirSync(join(root, "physical", "project"), { recursive: true });
  mkdirSync(join(root, "physical", "docs"));
  symlinkSync(join(root, "physical", "project"), cwd);
  symlinkSync(join(root, "lexical", "docs"), join(cwd, "docs-link"));
  const pattern = "Edit(../docs/**)";
  const lexicalEdit = call("edit", { path: "../docs/x.md" });
  const linkedEdit = call("edit", { path: "./docs-link/x.md" });
  const physicalEdit = call("edit", { path: join(root, "physical", "docs", "x.md") });

  assert.deepEqual(
    [
      ruleMatches(parse(pattern, "deny"), lexicalEdit, cwd),
      ruleMatches(parse(pattern, "ask"), lexicalEdit, cwd),
      ruleMatches(parse(pattern, "deny"), linkedEdit, cwd),
      ruleMatches(parse(pattern, "ask"), linkedEdit, cwd),
      ruleMatches(parse(pattern), lexicalEdit, cwd),
      ruleMatches(parse(pattern), physicalEdit, cwd),
    ],
    [true, true, true, true, true, false],
  );
});

test("deny and ask match only the folded resolved target through a symlinked cwd", (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "permissions-linked-folded-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "lexical", "project");
  const project = join(root, "physical", "project");
  mkdirSync(join(root, "lexical"));
  mkdirSync(join(project, "DOCS"), { recursive: true });
  symlinkSync(project, cwd);
  symlinkSync("DOCS", join(project, "alias"));
  const edit = call("edit", { path: "./alias/x.md" });
  const pattern = "Edit(./docs/**)";

  assert.equal(ruleMatches(parse(pattern, "deny"), edit, cwd), true);
  assert.equal(ruleMatches(parse(pattern, "ask"), edit, cwd), true);
  assert.equal(ruleMatches(parse(pattern), edit, cwd), false);
});

test("allow stays case-sensitive and deny folds case even on a missing path", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "permissions-case-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const edit = call("edit", { path: "./DOCS/x.md" });

  assert.equal(ruleMatches(parse("Edit(./docs/**)"), edit, cwd), false);
  assert.equal(ruleMatches(parse("Edit(./docs/**)", "deny"), edit, cwd), true);
});

test("wildcard markers do not change case folding next to a wildcard", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "permissions-folded-wildcard-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  assert.equal(ruleMatches(parse("Edit(./ΟΣ*)", "deny"), call("edit", { path: "./ος" }), cwd), true);
  assert.equal(ruleMatches(parse("Edit(./[0]*)", "deny"), call("edit", { path: "./unrelated" }), cwd), false);
});

test("deny normalizes NFC and NFD spellings even on a missing path", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "permissions-unicode-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const write = call("write", { path: "./Cafe\u0301/x.md" });

  assert.equal(ruleMatches(parse("Write(./Café/**)", "deny"), write, cwd), true);
});

test("path resolution errors match deny and ask but never allow", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "permissions-resolution-error-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  symlinkSync("loop", join(cwd, "loop"));
  symlinkSync("missing/../real", join(cwd, "unresolvable"));
  writeFileSync(join(cwd, "file"), "");

  for (const path of ["./loop/x.md", "./file/x.md", "./unresolvable"]) {
    const edit = call("edit", { path });
    assert.equal(ruleMatches(parse("Edit(./other/**)", "deny"), edit, cwd), true);
    assert.equal(ruleMatches(parse("Edit(./other/**)", "ask"), edit, cwd), true);
    assert.equal(ruleMatches(parse("Edit(./**)"), edit, cwd), false);
  }
});

describe("starter Read globs", () => {
  test("Read(./**) matches files under cwd and not sibling or outside paths", () => {
    const cwd = mkdtempSync(join(tmpdir(), "permissions-glob-"));
    try {
      const allow = parse("Read(./**)");
      assert.equal(ruleMatches(allow, call("read", { path: "CONTEXT.md" }), cwd), true);
      assert.equal(ruleMatches(allow, call("read", { path: "cmd/x/main.go" }), cwd), true);
      assert.equal(ruleMatches(allow, call("read", { path: `../${basename(cwd)}-other/x` }), cwd), false);
      assert.equal(ruleMatches(allow, call("read", { path: "/other/repo/README.md" }), cwd), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("nested secret-file deny globs match and beat the broad allow", () => {
    const cwd = mkdtempSync(join(tmpdir(), "permissions-secrets-"));
    try {
      const allow = parse("Read(./**)");
      const cases = [
        ["Read(./**/.env)", "config/.env"],
        ["Read(./**/.env.*)", "a/b/.env.local"],
        ["Read(./**/*.key)", "certs/server.key"],
        ["Read(./**/*.pem)", "x/y.pem"],
      ] as const;
      for (const [pattern, path] of cases) {
        const deny = parse(pattern, "deny");
        assert.equal(ruleMatches(deny, call("read", { path }), cwd), true, pattern);
        assert.equal(matchPermission(call("read", { path }), cwd, [allow, deny], true), deny, pattern);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("Read(~/.ssh/**) matches home SSH keys", () => {
    const cwd = mkdtempSync(join(tmpdir(), "permissions-ssh-"));
    try {
      assert.equal(ruleMatches(parse("Read(~/.ssh/**)", "deny"), call("read", { path: join(homedir(), ".ssh", "id_rsa") }), cwd), true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("untrusted project Read(./**) allow is ignored; trusted project allow applies", () => {
    const cwd = mkdtempSync(join(tmpdir(), "permissions-trust-"));
    try {
      const projectAllow = parse("Read(./**)", "allow", "project");
      assert.equal(matchPermission(call("read", { path: "CONTEXT.md" }), cwd, [projectAllow], false), undefined);
      assert.equal(matchPermission(call("read", { path: "CONTEXT.md" }), cwd, [projectAllow], true), projectAllow);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("permission matching", () => {
  test("Bash patterns match the entire raw command; only explicit stars are wildcards", () => {
    const exact = parse("Bash(git status)");
    for (const command of ["git status --short", "git status; rm file", " git status", "git status ", "git status\n"])
      assert.equal(ruleMatches(exact, call("bash", { command }), "/tmp"), false, JSON.stringify(command));
    assert.equal(ruleMatches(exact, call("bash", { command: "git status" }), "/tmp"), true);
    for (const command of ["echo . [] ? : (x)", "echo .x [] ? : (x)"])
      assert.equal(ruleMatches(parse(`Bash(${command})`), call("bash", { command }), "/tmp"), true);
    assert.equal(ruleMatches(parse("Bash(git push *)"), call("bash", { command: "git push origin" }), "/tmp"), true);
    assert.equal(ruleMatches(parse("Bash(git push *)"), call("bash", { command: "git push" }), "/tmp"), false);
    assert.equal(ruleMatches(parse("Bash(git  status)"), call("bash", { command: "git status" }), "/tmp"), false);
    assert.equal(ruleMatches(parse("Bash(*)"), call("bash", { command: "ends\n" }), "/tmp"), true);
    assert.equal(ruleMatches(exact, call("bash", { command: 1 }), "/tmp"), false);
  });

  test("raw deny and ask normalize wrappers in scanned segments without unwrapping shell evaluation", () => {
    for (const level of ["deny", "ask"] as const) {
      const rule = parse("Bash(preview *)", level);
      for (const command of [
        'before >out; env FOO=1 BAR="value with spaces" preview draft',
        "env FOO=1 preview",
        "command preview",
        "exec preview",
      ]) {
        assert.equal(ruleMatches(rule, call("bash", { command }), "/tmp"), true, command);
      }
      for (const command of ["bash -c 'preview draft'", "eval preview draft", "echo env preview draft"]) {
        assert.equal(ruleMatches(rule, call("bash", { command }), "/tmp"), false, command);
      }
    }
  });

  test("raw env stripping preserves the remainder and stops at unterminated values", () => {
    const rawRemainder = `preview 'draft note' > out`;
    const malformed = `env FOO=$'unfinished preview draft`;
    for (const level of ["deny", "ask"] as const) {
      const rule = parse(`Bash(${rawRemainder})`, level);
      const command = String.raw`env FOO=before"a\" b"' c' ${rawRemainder}`;
      assert.equal(ruleMatches(rule, call("bash", { command }), "/tmp"), true);
      const input = call("bash", { command: malformed });
      assert.equal(ruleMatches(parse("Bash(preview *)", level), input, "/tmp"), false);
      assert.equal(ruleMatches(parse(`Bash(${malformed})`, level), input, "/tmp"), true);
    }
  });

  test("applies deny, ask, allow precedence, global-before-project, and project trust", () => {
    const globalAllow = parse("Bash(*)", "allow");
    const projectAllow = parse("Bash(*)", "allow", "project");
    const globalAsk = parse("Bash(git status)", "ask");
    const projectDeny = parse("Bash(git status)", "deny", "project");
    const projectAsk = parse("Bash(git status)", "ask", "project");
    const globalDeny = parse("Bash(git status)", "deny");
    assert.equal(
      matchPermission(
        call("bash", { command: "git status" }),
        "/tmp",
        [globalAllow, projectAllow, globalAsk, projectDeny, globalDeny],
        true,
      ),
      globalDeny,
    );
    assert.equal(
      matchPermission(call("bash", { command: "git status" }), "/tmp", [projectDeny, globalAllow], true),
      projectDeny,
    );
    assert.equal(
      matchPermission(call("bash", { command: "git status" }), "/tmp", [globalAsk, projectAsk], true),
      globalAsk,
    );
    assert.equal(matchPermission(call("bash", { command: "git status" }), "/tmp", [projectAllow], false), undefined);
    assert.equal(matchPermission(call("bash", { command: "git status" }), "/tmp", [projectDeny], false), projectDeny);
    assert.equal(matchPermission(call("bash", { command: "git status" }), "/tmp", [projectAllow], true), projectAllow);
  });

  test("deny and ask inspect conservative shell segments, but allows only inspect whole commands", () => {
    for (const delimiter of [";", "&", "|", "\r", "\n", "`", "(", ")", "<", ">", "&&", "$(", ">"]) {
      const command = `safe ${delimiter} rm file`;
      assert.equal(ruleMatches(parse("Bash(rm *)", "ask"), call("bash", { command }), "/tmp"), true, delimiter);
    }
    assert.equal(
      ruleMatches(parse("Bash(git status)", "allow"), call("bash", { command: "git status; rm file" }), "/tmp"),
      false,
    );
    assert.equal(
      matchPermission(
        call("bash", { command: "git status; security" }),
        "/tmp",
        [parse("Bash(*)", "allow"), parse("Bash(security)", "deny")],
        true,
      )?.level,
      "deny",
    );
    assert.equal(
      matchPermission(call("bash", { command: "git status && rm file" }), "/tmp", [parse("Bash(rm *)", "ask")], true)
        ?.level,
      "ask",
    );
  });

  test("matches project-relative Read/Edit/Write globs and rejects sibling paths", () => {
    const cwd = mkdtempSync(join(tmpdir(), "permissions [literal]*() "));
    try {
      const envRule = parse("Read(./.env)");
      for (const path of [".env", "./.env", resolve(cwd, ".env"), "@.env"])
        assert.equal(ruleMatches(envRule, call("read", { path }), cwd), true, path);
      assert.equal(ruleMatches(parse("Edit(./.env)"), call("write", { path: ".env" }), cwd), true);
      assert.equal(ruleMatches(parse("Read(./.env.*)"), call("read", { path: ".env.example" }), cwd), true);
      assert.equal(ruleMatches(parse("Read(./secrets/**)"), call("read", { path: "secrets/nested/key" }), cwd), true);
      assert.equal(ruleMatches(parse("Read(./secrets/**)"), call("read", { path: "secretsX/a" }), cwd), false);
      assert.equal(ruleMatches(parse("Read(./secrets/*)"), call("read", { path: "secrets/nested/key" }), cwd), false);
      assert.equal(ruleMatches(envRule, call("read", { path: "../.env" }), cwd), false);
      assert.equal(ruleMatches(parse("Edit(./nested/../.env)", "deny"), call("write", { path: ".env" }), cwd), true);
      const sibling = `${cwd.replace("*", "-other")}/.env`;
      assert.equal(ruleMatches(envRule, call("read", { path: sibling }), cwd), false);
      assert.equal(ruleMatches(envRule, call("read", {}), cwd), false);
      assert.equal(ruleMatches(envRule, call("read", { path: 1 }), cwd), false);
      assert.equal(ruleMatches(envRule, call("read", { path: ".env\n" }), cwd), false);
      assert.equal(ruleMatches(parse("Read(./literal[1].env)"), call("read", { path: "literal[1].env" }), cwd), true);
      assert.equal(ruleMatches(parse("Read(./literal[1].env)"), call("read", { path: "literal1.env" }), cwd), false);
      assert.equal(
        ruleMatches(parse("Read(./literal space.env)"), call("read", { path: "literal\u00a0space.env" }), cwd),
        true,
      );
      assert.equal(ruleMatches(parse("Read(~/.env)"), call("read", { path: "~/.env" }), cwd), true);
      const encoded = pathToFileURL(join(cwd, ".env")).href;
      assert.equal(ruleMatches(envRule, call("read", { path: encoded }), cwd), true);
      assert.throws(() => ruleMatches(envRule, call("read", { path: "file://%zz" }), cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("resolves parent-relative allow and deny patterns only to the configured parent file", () => {
    const root = mkdtempSync(join(tmpdir(), "permissions-parent-"));
    const cwd = join(root, "project");
    mkdirSync(cwd);
    const parentFile = join(root, ".env");
    const projectFile = join(cwd, ".env");
    const otherFile = join(root, "other.env");
    writeFileSync(parentFile, "parent");
    writeFileSync(projectFile, "project");
    writeFileSync(otherFile, "other");
    try {
      for (const toolName of ["read", "edit", "write"]) {
        const ruleTool = toolName === "write" ? "Edit" : toolName === "edit" ? "Edit" : "Read";
        const allow = parse(`${ruleTool}(../.env)`);
        const deny = parse(`${ruleTool}(../.env)`, "deny");
        assert.equal(ruleMatches(allow, call(toolName, { path: "../.env" }), cwd), true, `${toolName} parent allow`);
        assert.equal(ruleMatches(deny, call(toolName, { path: parentFile }), cwd), true, `${toolName} parent deny`);
        assert.equal(ruleMatches(allow, call(toolName, { path: ".env" }), cwd), false, `${toolName} project sibling`);
        assert.equal(
          ruleMatches(allow, call(toolName, { path: otherFile }), cwd),
          false,
          `${toolName} unrelated sibling`,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("treats expanded HOME characters literally", () => {
    const home = mkdtempSync(join(tmpdir(), "permissions-home*"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = home;
      const sibling = `${home.replace("*", "-other")}/.env`;
      assert.equal(ruleMatches(parse("Read(~/.env)"), call("read", { path: sibling }), "/tmp"), false);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("matches project-relative rules when cwd is the filesystem root", () => {
    assert.equal(
      ruleMatches(parse("Read(./tmp/example.env)", "deny"), call("read", { path: "/tmp/example.env" }), "/"),
      true,
    );
  });

  test("mirrors native Read original-path priority and AM/PM fallback, without applying either to Edit/Write", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "permissions-read-"));
    try {
      const read = createReadTool(cwd);
      const requestedOriginal = join(cwd, "Capture d'écran.png");
      const originalFallback = join(cwd, "Capture d’écran.png");
      const requested = join(cwd, "Report 9 AM.pdf");
      const amPmFallback = join(cwd, "Report 9\u202fAM.pdf");
      writeFileSync(requestedOriginal, "original wins");
      writeFileSync(originalFallback, "fallback loses to original");
      writeFileSync(amPmFallback, "AM/PM fallback wins");

      const originalResult = await read.execute(
        "test-read-original",
        { path: requestedOriginal },
        new AbortController().signal,
      );
      assert.equal(JSON.stringify(originalResult).includes("original wins"), true);
      assert.equal(
        ruleMatches(parse("Read(./Capture d'écran.png)"), call("read", { path: requestedOriginal }), cwd),
        true,
      );
      assert.equal(
        ruleMatches(parse("Read(./Capture d’écran.png)"), call("read", { path: requestedOriginal }), cwd),
        false,
      );

      const amPmResult = await read.execute("test-read-ampm", { path: requested }, new AbortController().signal);
      assert.equal(JSON.stringify(amPmResult).includes("AM/PM fallback wins"), true);
      assert.equal(ruleMatches(parse("Read(./Report 9 AM.pdf)"), call("read", { path: requested }), cwd), false);
      assert.equal(ruleMatches(parse("Read(./Report 9\u202fAM.pdf)"), call("read", { path: requested }), cwd), true);
      assert.equal(ruleMatches(parse("Edit(./Report 9 AM.pdf)"), call("edit", { path: requested }), cwd), true);
      assert.equal(ruleMatches(parse("Edit(./Report 9\u202fAM.pdf)"), call("write", { path: requested }), cwd), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("keeps percent-encoded stars literal in configured file URLs", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "permissions-encoded-star-"));
    try {
      const literalStar = join(cwd, "literal*.txt");
      const sibling = join(cwd, "literal-SECRET.txt");
      writeFileSync(literalStar, "literal star target");
      writeFileSync(sibling, "sibling target");
      const encodedUrl = pathToFileURL(literalStar).href.replace("*", "%2A");
      const rule = parse(`Read(${encodedUrl})`, "deny");
      const read = createReadTool(cwd);
      const actualTarget = await read.execute("test-read-encoded-star", { path: encodedUrl }, new AbortController().signal);
      assert.equal(JSON.stringify(actualTarget).includes("literal star target"), true);
      assert.equal(ruleMatches(rule, call("read", { path: encodedUrl }), cwd), true);
      assert.equal(ruleMatches(rule, call("read", { path: sibling }), cwd), false);
      const siblingTarget = await read.execute(
        "test-read-encoded-star-sibling",
        { path: sibling },
        new AbortController().signal,
      );
      assert.equal(JSON.stringify(siblingTarget).includes("sibling target"), true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("trailing and repeated encoded stars stay literal and denied for native Read", async () => {
    const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "permissions-trailing-star-")));
    try {
      for (const name of ["secret*", "secret**", "secret*.txt", "__PI_STAR__*"]) {
        const target = join(cwd, name);
        const sibling = join(cwd, name.replaceAll("*", ""));
        writeFileSync(target, "denied target");
        writeFileSync(sibling, "allowed sibling");
        const url = pathToFileURL(target).href.replaceAll("*", "%2A");
        const deny = parse(`Read(${url})`, "deny");
        const allow = parse("Read");
        const native = await createReadTool(cwd).execute("encoded-star", { path: url }, new AbortController().signal);
        assert.equal(JSON.stringify(native).includes("denied target"), true);
        assert.equal(matchPermission(call("read", { path: url }), cwd, [allow, deny], true), deny, name);
        assert.equal(matchPermission(call("read", { path: sibling }), cwd, [allow, deny], true), allow, name);
      }
      const mixed = parse(`Read(${pathToFileURL(join(cwd, "secret*")).href.replaceAll("*", "%2A")}*)`);
      assert.equal(ruleMatches(mixed, call("read", { path: "secret*tail" }), cwd), true);
      assert.equal(ruleMatches(mixed, call("read", { path: "secrettail" }), cwd), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("wildcard markers cannot overlap adjacent literal filename prefixes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "permissions-marker-boundary-"));
    try {
      for (const prefix of ["[", "[0", "0]", "]", "[0]", "[0][1]"]) {
        const target = join(cwd, `${prefix}secret.txt`);
        const sibling = join(cwd, "unrelated_PI_STAR__");
        writeFileSync(target, "intended denied target");
        writeFileSync(sibling, "unintended sibling");
        const native = await createReadTool(cwd).execute("marker-boundary", { path: target }, new AbortController().signal);
        assert.equal(JSON.stringify(native).includes("intended denied target"), true);
        for (const pattern of [`./${prefix}*`, pathToFileURL(join(cwd, `${prefix}*`)).href]) {
          const deny = parse(`Read(${pattern})`, "deny");
          const allow = parse("Read");
          assert.equal(matchPermission(call("read", { path: target }), cwd, [allow, deny], true), deny, pattern);
          assert.equal(matchPermission(call("read", { path: sibling }), cwd, [allow, deny], true), allow, pattern);
        }
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("HOME dot segments resolve literally for Read, Edit and Write with deny precedence", async () => {
    const home = mkdtempSync(join(tmpdir(), "permissions-dot-home*"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = home;
      mkdirSync(join(home, "folder"));
      writeFileSync(join(home, ".env"), "home denied target");
      const native = await createReadTool(home).execute("home-dot", { path: "~/folder/../.env" }, new AbortController().signal);
      assert.equal(JSON.stringify(native).includes("home denied target"), true);
      for (const tool of ["read", "edit", "write"]) {
        const label = tool === "read" ? "Read" : "Edit";
        const allow = parse(tool === "read" ? "Read" : "Edit");
        for (const pattern of ["~/folder/../.env", "~/./.env", "~/folder/../.*"]) {
          const deny = parse(`${label}(${pattern})`, "deny");
          assert.equal(matchPermission(call(tool, { path: "~/.env" }), home, [allow, deny], true), deny, `${tool} ${pattern}`);
          assert.equal(ruleMatches(deny, call(tool, { path: join(home, "folder", ".env") }), home), false);
          assert.equal(ruleMatches(deny, call(tool, { path: join(home.replace("*", "-other"), ".env") }), home), false);
        }
      }
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("absolute U+202F AM/PM deny beats a broad allow for native Read fallback", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "permissions-absolute-ampm-"));
    try {
      const requested = join(cwd, "Report 9 AM.pdf");
      const physicalFallback = join(cwd, "Report 9\u202fAM.pdf");
      writeFileSync(physicalFallback, "physical fallback target");
      const nativeResult = await createReadTool(cwd).execute(
        "test-read-absolute-ampm",
        { path: requested },
        new AbortController().signal,
      );
      assert.equal(JSON.stringify(nativeResult).includes("physical fallback target"), true);

      const deny = parse(`Read(${physicalFallback})`, "deny");
      const allow = parse("Read(*)", "allow");
      assert.equal(matchPermission(call("read", { path: requested }), cwd, [allow, deny], true), deny);
      assert.equal(ruleMatches(deny, call("read", { path: requested }), cwd), true);
      assert.equal(ruleMatches(parse(`Read(${requested})`, "deny"), call("read", { path: requested }), cwd), true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("mirrors native Read's NFD-plus-curly combined fallback when distinguishable", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "permissions-read-combined-"));
    try {
      const requested = join(cwd, "Café's.txt");
      const combined = requested.normalize("NFD").replace(/'/g, "\u2019");
      writeFileSync(combined, "combined fallback target");
      const result = await createReadTool(cwd).execute(
        "test-read-combined",
        { path: requested },
        new AbortController().signal,
      );
      assert.equal(JSON.stringify(result).includes("combined fallback target"), true);
      const resolvedName = basename(realpathSync.native(combined));
      assert.equal(ruleMatches(parse(`Read(./${resolvedName})`), call("read", { path: requested }), cwd), true);
      assert.equal(ruleMatches(parse("Edit(./Café's.txt)"), call("edit", { path: requested }), cwd), true);
      assert.equal(ruleMatches(parse("Edit(./Cafe\u0301’s.txt)"), call("write", { path: requested }), cwd), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
