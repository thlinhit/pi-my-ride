import assert from "node:assert/strict";
import { test } from "node:test";
import { handleToolCall } from "../src/index.ts";
import { parseConfig } from "../src/config.ts";
import { parseVerdict } from "../src/review/protocol.ts";

const revision = { decision: "revise" as const, reason: "Change target", constraint: "Use approved target", source: "User request" };

for (const tool of ["read", "bash"]) for (const hasUI of [true, false]) for (const accepted of [true, false]) {
  test(`revision confirmation ${tool} UI=${hasUI} accepted=${accepted}`, async () => {
    const input = tool === "read" ? { path: "/skills/obsidian/SKILL.md" } : { command: "printenv PI_SESSION_ID | cut -c 1-36" };
    const prompts: string[] = [];
    const reviewed: unknown[] = [];
    const result = await handleToolCall({ toolName: tool, input }, {
      cwd: "/tmp", hasUI, signal: undefined, isProjectTrusted: () => true,
      ui: { notify: () => {}, confirm: async (_title, message) => { prompts.push(message); return accepted; } },
    }, () => parseConfig({}, "test"), { review: async request => { reviewed.push(request); return { ok: true, verdict: revision }; } });
    assert.equal(result === undefined, hasUI && accepted);
    assert.equal(prompts.length, hasUI ? 1 : 0);
    assert.equal(reviewed.length, tool === "bash" ? 2 : 1);
    if (hasUI) { assert.match(prompts[0]!, /Reviewer requested a revision/); assert.match(prompts[0]!, /Constraint: Use approved target/); assert.match(prompts[0]!, /Source: User request/); assert.ok(prompts[0]!.includes(tool === "bash" ? input.command! : input.path!)); }
  });
}

test("valid revision preserves evidence while other verdicts need none", () => {
  assert.deepEqual(parseVerdict(JSON.stringify(revision)), { ok: true, verdict: revision });
  for (const decision of ["approve", "ask_user"]) assert.equal(parseVerdict(JSON.stringify({ decision, reason: "ok" })).ok, true);
  for (const value of [null, [], 1, "x"]) assert.equal(parseVerdict(JSON.stringify(value)).ok, false);
});

test("hard denies preflight the complete command before revision or confirmation", async () => {
  let reviews = 0; let confirmations = 0;
  for (const command of ["danger", "first;danger"]) {
    const result = await handleToolCall({ toolName: "bash", input: { command } }, {
      cwd: "/tmp", hasUI: true, signal: undefined, isProjectTrusted: () => true,
      ui: { notify: () => {}, confirm: async () => { confirmations++; return true; } },
    }, () => parseConfig({ permissions: { deny: ["Bash(danger)"] } }, "test"), { review: async () => { reviews++; return { ok: true, verdict: revision }; } });
    assert.match(result!.reason, /Blocked by auto-approval/);
  }
  assert.equal(reviews, 0); assert.equal(confirmations, 0);
});

test("revision verdict requires structured constraint and source", () => {
  for (const evidence of [{}, { constraint: "Use lowercase" }, { source: "User request" }, { constraint: " ", source: "User request" }, { constraint: "target", source: " " }, { constraint: 1, source: "user" }, { constraint: "target", source: [] }]) {
    assert.equal(parseVerdict(JSON.stringify({ decision: "revise", reason: "Fix message", ...evidence })).ok, false);
  }
});
