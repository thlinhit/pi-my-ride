import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { HISTORY_RELATIVE_PATH, recordHistory, redactSecrets } from "../src/history.ts";

const roots: string[] = [];
function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-history-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("redacts supported secret forms and preserves benign text", () => {
  const examples = [
    "Authorization: Basic abcd",
    "Bearer token-value",
    "AKIA1234567890ABCDEF",
    "ghp_abcdefghijklmnopqrstuvwxyz123456",
    "github_pat_abcdefghijklmnopqrstuvwxyz123456",
    "sk-abcdefghijklmnopqrstuvwxyz123456",
    "xoxb-1234567890-1234567890-abcdefghijklmnop",
    "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
    "https://user:password@example.com/path",
    "--password 'two words here'",
    '--token="a token value"',
    "--secret plain-value",
    'MY_API_KEY="a key with spaces"',
    "service_password=abc123",
    "TOKEN=unquoted value with spaces; echo done",
    "NODE_ENV=production API_TOKEN=plain-sensitive-value npm start",
    `--password "alpha \\"bravo charlie\\" delta"`,
    `TOKEN="alpha \\"bravo charlie\\" delta"`,
    "api-key=plain-lowercase-value",
    'API-KEY="quoted uppercase value"',
    "TOKEN=alpha beta gamma",
    "PASSWORD=delta epsilon zeta",
    "SECRET=eta theta iota",
    "API_KEY=kappa lambda mu",
    "SERVICE_CREDENTIAL=nu xi omicron",
    "prefix TOKEN=pi rho sigma",
    "prefix PASSWORD=tau upsilon phi",
  ];
  for (const value of examples) {
    const result = redactSecrets(value);
    assert.ok(result.includes("[REDACTED]"), `expected redaction for ${value}`);
    const completeValues = [
      "Basic abcd",
      "token-value",
      "AKIA1234567890ABCDEF",
      "abcdefghijklmnopqrstuvwxyz123456",
      "two words here",
      "a token value",
      "plain-value",
      "a key with spaces",
      "abc123",
      "unquoted value with spaces",
      "user:password",
      "1234567890-1234567890-abcdefghijklmnop",
      "secret\n-----END PRIVATE KEY",
      "plain-sensitive-value",
      "bravo charlie",
      "plain-lowercase-value",
      "quoted uppercase value",
    ];
    for (const secret of completeValues) {
      if (value.includes(secret)) assert.ok(!result.includes(secret), `secret remained: ${secret}`);
    }
  }
  assert.equal(redactSecrets("echo hello world"), "echo hello world");
  for (const value of [
    "TOKEN=alpha beta gamma",
    "PASSWORD=delta epsilon zeta",
    "SECRET=eta theta iota",
    "API_KEY=kappa lambda mu",
    "SERVICE_CREDENTIAL=nu xi omicron",
    "prefix TOKEN=pi rho sigma",
    "prefix PASSWORD=tau upsilon phi",
  ]) {
    const redacted = redactSecrets(value);
    for (const secret of value.split("=")[1]!.split(" ")) {
      if (secret) assert.ok(!redacted.includes(secret), `secret fragment remained: ${secret} in ${redacted}`);
    }
  }
});

test("writes exact JSONL fields with ISO time and appends entries in a created directory", () => {
  const cwd = tempDir();
  const time = new Date("2026-01-02T03:04:05.000Z");
  assert.equal(HISTORY_RELATIVE_PATH, join(".pi", "pi-auto-approval", "history.jsonl"));
  assert.deepEqual(
    recordHistory(cwd, { tool: "bash", command: "echo token=abc", decision: "approved" }, { now: () => time }),
    { ok: true },
  );
  assert.deepEqual(recordHistory(cwd, { tool: "read", command: ".env", decision: "blocked" }, { now: () => time }), {
    ok: true,
  });
  const lines = readFileSync(join(cwd, HISTORY_RELATIVE_PATH), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.deepEqual(Object.keys(lines[0]).sort(), ["command", "decision", "time", "tool"]);
  assert.equal(lines[0].time, time.toISOString());
  assert.equal(lines[0].command.includes("abc"), false);
  assert.deepEqual(lines[1], { time: time.toISOString(), tool: "read", command: ".env", decision: "blocked" });
});

test("redaction failure leaves absent history absent and existing history unchanged", () => {
  const cwd = tempDir();
  const redactor = () => {
    throw new Error("private redactor detail");
  };
  const absent = recordHistory(
    cwd,
    { tool: "bash", command: "raw-secret", decision: "approved" },
    { redact: redactor },
  );
  assert.deepEqual(absent, { ok: false, error: "History redaction failed" });
  const history = join(cwd, HISTORY_RELATIVE_PATH);
  assert.equal(existsSync(join(cwd, ".pi", "pi-auto-approval")), false);
  assert.equal(existsSync(history), false);
  mkdirSync(join(cwd, ".pi", "pi-auto-approval"), { recursive: true });
  writeFileSync(history, "existing bytes\n");
  const existing = recordHistory(
    cwd,
    { tool: "bash", command: "raw-secret", decision: "blocked" },
    { redact: redactor },
  );
  assert.deepEqual(existing, { ok: false, error: "History redaction failed" });
  assert.equal(readFileSync(history, "utf8"), "existing bytes\n");
});

test("recordHistory never writes mixed sensitive assignment values", () => {
  const cwd = tempDir();
  const result = recordHistory(cwd, {
    tool: "bash",
    command: "NODE_ENV=production API_TOKEN=plain-sensitive-value npm start",
    decision: "approved",
  });
  assert.deepEqual(result, { ok: true });
  const saved = readFileSync(join(cwd, HISTORY_RELATIVE_PATH), "utf8");
  assert.ok(saved.includes("[REDACTED]"));
  assert.ok(!saved.includes("plain-sensitive-value"));
});

test("JSONL redacts complete unquoted values for bare and prefixed sensitive assignments", () => {
  const cwd = tempDir();
  const command =
    "TOKEN=alpha beta gamma PASSWORD=delta epsilon zeta SECRET=eta theta iota API_KEY=kappa lambda mu CREDENTIAL=nu xi omicron";
  assert.deepEqual(recordHistory(cwd, { tool: "bash", command, decision: "approved" }), { ok: true });
  const saved = readFileSync(join(cwd, HISTORY_RELATIVE_PATH), "utf8");
  assert.ok(!saved.includes("alpha beta gamma"));
  assert.ok(!saved.includes("beta gamma"));
  assert.ok(!saved.includes("delta epsilon zeta"));
  assert.ok(!saved.includes("epsilon zeta"));
  assert.ok(!saved.includes("eta theta iota"));
  assert.ok(!saved.includes("theta iota"));
  assert.ok(!saved.includes("kappa lambda mu"));
  assert.ok(!saved.includes("lambda mu"));
  assert.ok(!saved.includes("nu xi omicron"));
  assert.ok(!saved.includes("xi omicron"));
});

test("redacts quoted delimiter values and nested sensitive CLI assignments", () => {
  const commands = [
    'TOKEN="first; trailing-secret" curl https://example.com',
    "TOKEN='second; trailing-secret' curl https://example.com",
    "docker run --env=API_TOKEN=private-value image",
    "curl --data-urlencode=client_secret=other-private-value https://example.com",
  ];
  for (const command of commands) {
    const redacted = redactSecrets(command);
    assert.ok(!redacted.includes("trailing-secret"), `quoted secret fragment remained: ${redacted}`);
    assert.ok(!redacted.includes("private-value"), `nested secret remained: ${redacted}`);
  }

  const cwd = tempDir();
  assert.deepEqual(recordHistory(cwd, { tool: "bash", command: commands.join(" && "), decision: "approved" }), {
    ok: true,
  });
  const saved = readFileSync(join(cwd, HISTORY_RELATIVE_PATH), "utf8");
  assert.ok(!saved.includes("trailing-secret"));
  assert.ok(!saved.includes("private-value"));
});

test("redacts suffixed names and complete composed assignment spans", () => {
  const commands = [
    'TOKEN_VALUE="token-prefix token-tail"',
    "SECRET_KEY=secret-prefix secret-tail",
    'PASSWORD_HASH="password-prefix password-tail"',
    "API_KEY_VALUE=api-prefix api-tail",
    'CREDENTIALS="credential-prefix credential-tail"',
    'TOKEN="first; trailing-secret Bearer bearer-secret"',
    'SECRET_KEY="first; trailing-secret https://url-user:url-password@example.com/path"',
    "docker run --env=API_TOKEN=private-prefix private-tail image",
  ];
  const secretFragments = [
    "token-prefix",
    "token-tail",
    "secret-prefix",
    "secret-tail",
    "password-prefix",
    "password-tail",
    "api-prefix",
    "api-tail",
    "credential-prefix",
    "credential-tail",
    "trailing-secret",
    "bearer-secret",
    "url-user",
    "url-password",
    "private-prefix",
    "private-tail",
  ];

  for (const command of commands) {
    const redacted = redactSecrets(command);
    for (const fragment of secretFragments) {
      if (command.includes(fragment))
        assert.ok(!redacted.includes(fragment), `pure redactor retained ${fragment}: ${redacted}`);
    }
  }

  const cwd = tempDir();
  const command = commands.join(" && ");
  assert.deepEqual(recordHistory(cwd, { tool: "bash", command, decision: "approved" }), { ok: true });
  const saved = readFileSync(join(cwd, HISTORY_RELATIVE_PATH), "utf8");
  for (const fragment of secretFragments) {
    if (command.includes(fragment)) assert.ok(!saved.includes(fragment), `JSONL retained ${fragment}: ${saved}`);
  }
});

test("redacts padded sensitive values in pure output and JSONL", () => {
  const command = "TOKEN=base64payload==";
  const pure = redactSecrets(command);
  const cwd = tempDir();
  assert.deepEqual(recordHistory(cwd, { tool: "bash", command, decision: "approved" }), { ok: true });
  const saved = readFileSync(join(cwd, HISTORY_RELATIVE_PATH), "utf8");
  assert.deepEqual([pure.includes("base64payload=="), saved.includes("base64payload==")], [false, false]);
});

test("redacts nested sensitive assignments in pure output and JSONL", () => {
  const command = 'DATA="client_secret=private-value"';
  const pure = redactSecrets(command);
  const cwd = tempDir();
  assert.deepEqual(recordHistory(cwd, { tool: "bash", command, decision: "approved" }), { ok: true });
  const saved = readFileSync(join(cwd, HISTORY_RELATIVE_PATH), "utf8");
  assert.deepEqual([pure.includes("private-value"), saved.includes("private-value")], [false, false]);
});

test("retains enclosing quotes while redacting nested quoted CLI assignments", () => {
  const commands = [
    'docker run --env="API_TOKEN=first; trailing-secret" image',
    'curl --data-urlencode="client_secret=first; trailing-secret" https://example.com',
  ];
  const cwd = tempDir();
  const command = commands.join(" && ");
  const pure = commands.map((value) => redactSecrets(value));
  assert.deepEqual(recordHistory(cwd, { tool: "bash", command, decision: "approved" }), { ok: true });
  const saved = readFileSync(join(cwd, HISTORY_RELATIVE_PATH), "utf8");
  const leaks = [
    ...pure.flatMap((value) => [value.includes("first"), value.includes("trailing-secret")]),
    saved.includes("first"),
    saved.includes("trailing-secret"),
  ];
  assert.deepEqual(leaks, Array(leaks.length).fill(false));
});

test("redacts mixed padded values and quoted delimiter combinations", () => {
  const commands = [
    "TOKEN=base64payload== API_TOKEN=second-padded== NODE_ENV=production",
    'DATA="client_secret=private-value; another-secret"',
    'DATA="API_TOKEN=first; trailing-secret"; PASSWORD=last-secret==',
    'DATA="client_secret=first; still-secret \\"quoted\\" tail"',
  ];
  const secretFragments = [
    "base64payload==",
    "second-padded==",
    "private-value",
    "another-secret",
    "first",
    "trailing-secret",
    "last-secret==",
    "still-secret",
    "quoted",
    "tail",
  ];

  for (const command of commands) {
    const redacted = redactSecrets(command);
    for (const fragment of secretFragments) {
      if (command.includes(fragment))
        assert.ok(!redacted.includes(fragment), `pure output retained ${fragment}: ${redacted}`);
    }
  }

  const cwd = tempDir();
  const command = commands.join(" && ");
  assert.deepEqual(recordHistory(cwd, { tool: "bash", command, decision: "approved" }), { ok: true });
  const saved = readFileSync(join(cwd, HISTORY_RELATIVE_PATH), "utf8");
  for (const fragment of secretFragments) {
    if (command.includes(fragment)) assert.ok(!saved.includes(fragment), `JSONL retained ${fragment}: ${saved}`);
  }
});

test("continues scanning after an empty nested value closes its enclosing quote", () => {
  const cases = [
    { command: 'DATA="client_secret="; PASSWORD="double-assignment-secret"', secret: "double-assignment-secret" },
    { command: "DATA='client_secret='; PASSWORD='single-assignment-secret'", secret: "single-assignment-secret" },
    { command: 'DATA="client_secret="; --password "double-option-secret"', secret: "double-option-secret" },
    { command: "DATA='client_secret='; --password 'single-option-secret'", secret: "single-option-secret" },
  ];
  const cwd = tempDir();
  const pure = cases.map(({ command }) => redactSecrets(command));
  for (const { command } of cases) {
    assert.deepEqual(recordHistory(cwd, { tool: "bash", command, decision: "approved" }), { ok: true });
  }
  const saved = readFileSync(join(cwd, HISTORY_RELATIVE_PATH), "utf8");
  const leaks = cases.flatMap(({ secret }, index) => [
    ...(pure[index]!.includes(secret) ? [`pure output retained ${secret}`] : []),
    ...(saved.includes(secret) ? [`JSONL retained ${secret}`] : []),
  ]);
  assert.deepEqual(leaks, []);
});

test("single-quoted backslashes do not hide following sensitive values", () => {
  const cases = [
    {
      command: String.raw`TOKEN='first\' PASSWORD='second-assignment-secret'`,
      secrets: ["first\\", "second-assignment-secret"],
    },
    {
      command: String.raw`DATA='client_secret=first\'; PASSWORD='second-nested-secret'`,
      secrets: ["first\\", "second-nested-secret"],
    },
    {
      command: String.raw`--password 'first\' --token 'second-option-secret'`,
      secrets: ["first\\", "second-option-secret"],
    },
    {
      command: String.raw`--password 'first\\' --token 'second-back-to-back-secret'`,
      secrets: ["first\\\\", "second-back-to-back-secret"],
    },
    {
      command: String.raw`TOKEN="first\\" PASSWORD="second-double-secret"`,
      secrets: ["first\\\\", "second-double-secret"],
    },
    {
      command: String.raw`TOKEN="first\"still-secret" PASSWORD="after-escaped-quote-secret"`,
      secrets: ['first\\\\"still-secret', "after-escaped-quote-secret"],
    },
    {
      command: String.raw`--password "first\\" --token "second-double-option-secret"`,
      secrets: ["first\\\\", "second-double-option-secret"],
    },
    {
      command: String.raw`--password "first\"still-secret" --token "second-double-escaped-option-secret"`,
      secrets: ['first\\"still-secret', "second-double-escaped-option-secret"],
    },
  ];
  const cwd = tempDir();

  const pureLeaks: string[] = [];
  for (const { command, secrets } of cases) {
    const pure = redactSecrets(command);
    for (const secret of secrets) {
      if (pure.includes(secret)) pureLeaks.push(`${secret}: ${pure}`);
    }
    assert.deepEqual(recordHistory(cwd, { tool: "bash", command, decision: "approved" }), { ok: true });
  }

  const saved = readFileSync(join(cwd, HISTORY_RELATIVE_PATH), "utf8");
  const jsonlLeaks = cases.flatMap(({ secrets }) => secrets.filter((secret) => saved.includes(secret)));
  assert.deepEqual({ pureLeaks, jsonlLeaks }, { pureLeaks: [], jsonlLeaks: [] });
});

test("redacts nested CLI overlaps without leaking suffixes in pure output or JSONL", () => {
  const commands = [
    {
      command: `curl --password "first --token 'x' trailing-secret"`,
      secrets: ["first", "x", "trailing-secret", "ng-secret"],
    },
    {
      command: `curl --password 'first --token "x" trailing-secret'`,
      secrets: ["first", "x", "trailing-secret", "ng-secret"],
    },
  ];
  const cwd = tempDir();
  const pure = commands.map(({ command }) => redactSecrets(command));
  for (const { command } of commands) {
    assert.deepEqual(recordHistory(cwd, { tool: "bash", command, decision: "approved" }), { ok: true });
  }
  const saved = readFileSync(join(cwd, HISTORY_RELATIVE_PATH), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as { command: string });
  for (const [index, { secrets }] of commands.entries()) {
    for (const secret of secrets) {
      assert.ok(!pure[index]!.includes(secret), `pure output retained ${secret}: ${pure[index]}`);
      assert.ok(!saved[index]!.command.includes(secret), `JSONL retained ${secret}: ${saved[index]!.command}`);
    }
  }
});

test("unquoted scanners honor escaped delimiters, backslash parity, and later secrets", () => {
  const commands = [
    {
      command: String.raw`TOKEN=first\;trailing-secret PASSWORD=next-assignment-secret`,
      secrets: ["first", "trailing-secret", "next-assignment-secret"],
    },
    {
      command: String.raw`TOKEN=first\\; PASSWORD=next-even-assignment-secret`,
      secrets: ["first", "next-even-assignment-secret"],
    },
    {
      command: String.raw`curl --token first\;trailing-secret --password next-option-secret`,
      secrets: ["first", "trailing-secret", "next-option-secret"],
    },
    {
      command: String.raw`curl --token first\\; --password next-even-option-secret`,
      secrets: ["first", "next-even-option-secret"],
    },
  ];
  const cwd = tempDir();
  const pure = commands.map(({ command }) => redactSecrets(command));
  for (const { command } of commands) {
    assert.deepEqual(recordHistory(cwd, { tool: "bash", command, decision: "approved" }), { ok: true });
  }
  const saved = readFileSync(join(cwd, HISTORY_RELATIVE_PATH), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as { command: string });
  for (const [index, { secrets }] of commands.entries()) {
    for (const secret of secrets) {
      assert.ok(!pure[index]!.includes(secret), `pure output retained ${secret}: ${pure[index]}`);
      assert.ok(!saved[index]!.command.includes(secret), `JSONL retained ${secret}: ${saved[index]!.command}`);
    }
  }
});

test("handles escaped quote openers and quote transitions inside unquoted values", () => {
  const cases = [
    String.raw`echo \"; PASSWORD="escaped-double-secret"; TOKEN="later-token-secret"`,
    String.raw`echo \'; PASSWORD='escaped-single-secret'; TOKEN='later-single-token-secret'`,
    String.raw`echo \\\\ PASSWORD="even-backslash-secret"`,
    String.raw`TOKEN=first"second;tail-assignment-secret"; PASSWORD="following-password-secret"`,
    String.raw`TOKEN=first'second;tail-single-secret'; PASSWORD="following-single-password-secret"`,
    String.raw`curl --token first"second;tail-option-secret"; --password="following-option-secret"`,
    String.raw`curl --token first'second;tail-single-option-secret'; --password='following-single-option-secret'`,
  ];
  const cwd = tempDir();
  const pure = cases.map(redactSecrets);
  for (const command of cases) {
    assert.deepEqual(recordHistory(cwd, { tool: "bash", command, decision: "approved" }), { ok: true });
  }
  const saved = readFileSync(join(cwd, HISTORY_RELATIVE_PATH), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => (JSON.parse(line) as { command: string }).command);
  const leaks = cases.flatMap((command, index) => [
    ...[
      "escaped-double-secret",
      "later-token-secret",
      "escaped-single-secret",
      "later-single-token-secret",
      "even-backslash-secret",
      "tail-assignment-secret",
      "following-password-secret",
      "tail-single-secret",
      "following-single-password-secret",
      "tail-option-secret",
      "following-option-secret",
      "tail-single-option-secret",
      "following-single-option-secret",
    ]
      .filter((fragment) => command.includes(fragment))
      .flatMap((fragment) => [
        ...(pure[index]!.includes(fragment) ? [`pure retained ${fragment}: ${pure[index]}`] : []),
        ...(saved[index]!.includes(fragment) ? [`JSONL retained ${fragment}: ${saved[index]}`] : []),
      ]),
  ]);
  assert.deepEqual(leaks, []);
});

test("quoted-start values redact concatenated quoted and bare segments", () => {
  const cases = [
    {
      command: `TOKEN="prefix"tail-sensitive; PASSWORD="following-sensitive"`,
      secrets: ["prefix", "tail-sensitive", "following-sensitive"],
    },
    {
      command: `TOKEN='prefix'tail-sensitive; PASSWORD='following-single-sensitive'`,
      secrets: ["prefix", "tail-sensitive", "following-single-sensitive"],
    },
    { command: `TOKEN="a"'b-sensitive'"c-sensitive"`, secrets: ["a", "b-sensitive", "c-sensitive"] },
    { command: String.raw`TOKEN="a"\;tail-sensitive`, secrets: ["a", "tail-sensitive"] },
    {
      command: `curl --token "prefix"tail-sensitive; --password="following-cli-sensitive"`,
      secrets: ["prefix", "tail-sensitive", "following-cli-sensitive"],
    },
    { command: `TOKEN="a b" tail-benign X=1`, secrets: ["a b"] },
  ];
  const cwd = tempDir();
  const pure = cases.map(({ command }) => redactSecrets(command));
  for (const { command } of cases)
    assert.deepEqual(recordHistory(cwd, { tool: "bash", command, decision: "approved" }), { ok: true });
  const saved = readFileSync(join(cwd, HISTORY_RELATIVE_PATH), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => (JSON.parse(line) as { command: string }).command);
  for (const [index, { secrets }] of cases.entries()) {
    for (const secret of secrets) {
      assert.ok(!pure[index]!.includes(secret), `pure output retained ${secret}: ${pure[index]}`);
      assert.ok(!saved[index]!.includes(secret), `JSONL retained ${secret}: ${saved[index]}`);
    }
  }
  assert.match(pure[5]!, / X=1$/);
});

test("redacts concatenated nested values without losing separators or benign tails", () => {
  const cases = [
    {
      command: 'docker run --env="API_TOKEN=prefix"tail-sensitive image',
      expected: 'docker run --env="API_TOKEN=[REDACTED]" image',
      secrets: ["prefix", "tail-sensitive"],
    },
    {
      command: 'DATA="client_secret="tail-sensitive',
      expected: 'DATA="client_secret=[REDACTED]"',
      secrets: ["tail-sensitive"],
    },
    {
      command: "docker run --env='API_TOKEN=prefix'tail-single-sensitive image",
      expected: "docker run --env='API_TOKEN=[REDACTED]' image",
      secrets: ["prefix", "tail-single-sensitive"],
    },
    {
      command: "DATA='client_secret='tail-empty-sensitive",
      expected: "DATA='client_secret=[REDACTED]'",
      secrets: ["tail-empty-sensitive"],
    },
    {
      command: 'DATA="client_secret=prefix"\'quoted-tail\'bare-tail PASSWORD="following-secret"',
      expected: 'DATA="client_secret=[REDACTED]" PASSWORD="[REDACTED]"',
      secrets: ["prefix", "quoted-tail", "bare-tail", "following-secret"],
    },
    {
      command: 'TOKEN="a b" X=1',
      expected: 'TOKEN="[REDACTED]" X=1',
      secrets: [],
    },
    {
      command: 'TOKEN="a" tail-benign',
      expected: 'TOKEN="[REDACTED]" tail-benign',
      secrets: [],
    },
    {
      command: '--token "a" next',
      expected: '--token "[REDACTED]" next',
      secrets: [],
    },
    {
      command: 'TOKEN=unquoted value with spaces; PASSWORD="later-sensitive"',
      expected: 'TOKEN=[REDACTED]; PASSWORD="[REDACTED]"',
      secrets: ["unquoted", "value with spaces", "later-sensitive"],
    },
  ];
  const cwd = tempDir();
  const failures: string[] = [];

  for (const { command, expected, secrets } of cases) {
    const pure = redactSecrets(command);
    if (pure !== expected) failures.push(`pure output: ${JSON.stringify(pure)} !== ${JSON.stringify(expected)}`);
    assert.deepEqual(recordHistory(cwd, { tool: "bash", command, decision: "approved" }), { ok: true });
    const saved = readFileSync(join(cwd, HISTORY_RELATIVE_PATH), "utf8").trimEnd().split("\n").at(-1)!;
    const parsed = JSON.parse(saved) as { command: string };
    if (parsed.command !== expected)
      failures.push(`JSONL output: ${JSON.stringify(parsed.command)} !== ${JSON.stringify(expected)}`);
    for (const secret of secrets) {
      if (pure.includes(secret)) failures.push(`pure output retained ${secret}: ${pure}`);
      if (parsed.command.includes(secret)) failures.push(`JSONL retained ${secret}: ${parsed.command}`);
    }
  }
  assert.deepEqual(failures, []);
});

test("append or mkdir failure returns a decision-neutral error", () => {
  const cwd = tempDir();
  writeFileSync(join(cwd, ".pi"), "not a directory");
  const result = recordHistory(cwd, { tool: "bash", command: "safe", decision: "approved" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(typeof result.error, "string");
});
