import assert from "node:assert/strict";
import test from "node:test";
import { formatStatusLines, isTerminal, widgetLines } from "../../src/ui/status.ts";
import type { ReviewStatus } from "../../src/ui/status.ts";

const status = (overrides: Partial<ReviewStatus> = {}): ReviewStatus => ({
  toolCallId: "call-1",
  state: "guardian-running",
  label: "danger command",
  ...overrides,
});

test("formats every row state with label and reviewer only while running", () => {
  assert.deepEqual(formatStatusLines(status({ reviewer: "openai · gpt-5" })), ["◌ guardian running · danger command · openai · gpt-5"]);
  assert.deepEqual(formatStatusLines(status({ state: "approval-required", source: "global.json", detail: "Requires confirmation" })), [
    "? approval required · danger command",
    "source: global.json",
    "Requires confirmation",
  ]);
  assert.deepEqual(formatStatusLines(status({ state: "approved", source: "global.json" })), ["✓ approved · danger command", "source: global.json"]);
  assert.deepEqual(formatStatusLines(status({ state: "revision-requested", detail: "Target mismatch." })), [
    "↻ revision requested · danger command",
    "Target mismatch.",
  ]);
  assert.deepEqual(formatStatusLines(status({ state: "blocked", label: "Unmatched Bash command" })), ["✗ blocked · Unmatched Bash command"]);
});

test("keeps source and detail as separate lines and omits unavailable metadata", () => {
  assert.deepEqual(formatStatusLines(status({ reviewer: "reviewer-name", source: "global.json", detail: "detail" })), [
    "◌ guardian running · danger command · reviewer-name",
    "source: global.json",
    "detail",
  ]);
  assert.deepEqual(formatStatusLines(status({ state: "approved", reviewer: "ignored" })), ["✓ approved · danger command"]);
});

test("maps ordinary widget status and cancellation detail", () => {
  assert.deepEqual(widgetLines(status({ state: "guardian-running" })), ["auto-approval: reviewing [danger command]"]);
  assert.deepEqual(widgetLines(status({ state: "approval-required" })), ["auto-approval: reviewing [danger command]"]);
  assert.deepEqual(widgetLines(status({ state: "approved" })), ["auto-approval: approved [danger command]"]);
  assert.deepEqual(widgetLines(status({ state: "blocked" })), ["auto-approval: blocked [danger command]"]);
  assert.deepEqual(widgetLines(status({ state: "revision-requested", detail: "Cancelled" })), [
    "auto-approval: blocked [danger command]",
    "Cancelled",
  ]);
});

test("identifies terminal states", () => {
  assert.equal(isTerminal("approved"), true);
  assert.equal(isTerminal("blocked"), true);
  assert.equal(isTerminal("revision-requested"), false);
  assert.equal(isTerminal("guardian-running"), false);
  assert.equal(isTerminal("approval-required"), false);
});
