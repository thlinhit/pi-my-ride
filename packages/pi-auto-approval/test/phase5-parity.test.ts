import assert from "node:assert/strict";
import test from "node:test";
import type { ConfigResult } from "../src/config.ts";
import { handleToolCall } from "../src/index.ts";
import type { ReviewResult } from "../src/index.ts";
import { parsePermissionRule } from "../src/rules.ts";
import type { PermissionRule } from "../src/rules.ts";

const bashEvent = { toolName: "bash", toolCallId: "parity-call", input: { command: "danger; echo harmless" } };
function baseRule(level: PermissionRule["level"], scope: PermissionRule["scope"] = "global", specifier = "danger"): PermissionRule {
  const parsed = parsePermissionRule(`Bash(${specifier})`, level, `${scope}.json`, scope, "fixture");
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

interface RunResult {
  decision: unknown;
  reports: unknown[];
  confirmations: unknown[][];
  reviews: unknown[];
}

async function runRoute(placement: "widget" | "toolRow", options: {
  rules?: PermissionRule[];
  mode?: "manual" | "auto";
  enabled?: boolean;
  trusted?: boolean;
  invalid?: boolean;
  command?: string;
  review?: (input: unknown) => Promise<ReviewResult>;
  confirm?: () => Promise<boolean>;
  aborted?: boolean;
}): Promise<RunResult> {
  const reports: unknown[] = [];
  const confirmations: unknown[][] = [];
  const reviews: unknown[] = [];
  const config: ConfigResult = options.invalid ? { ok: false, error: "invalid fixture" } : {
    ok: true,
    rules: options.rules ?? [],
    enabled: options.enabled ?? true,
    reviewMode: options.mode ?? "manual",
    ui: { status: true, placement },
    reviewer: { reasoningEffort: "low", timeoutMs: 30_000 },
    reviewEvidence: { projectInstructions: false },
  };
  const decision = await handleToolCall({ ...bashEvent, input: { command: options.command ?? "danger; echo harmless" } }, {
    cwd: "/tmp",
    hasUI: true,
    signal: options.aborted ? AbortSignal.abort() : undefined,
    isProjectTrusted: () => options.trusted ?? true,
    ui: {
      confirm: async (...args) => { confirmations.push(args); return options.confirm ? options.confirm() : true; },
      notify: () => {},
    },
  }, () => config, {
    status: (report) => reports.push(report),
    review: async (input) => {
      reviews.push(input);
      return options.review ? options.review(input) : { ok: true, verdict: { decision: "approve", reason: "approved by fixture" } };
    },
  });
  return { decision, reports, confirmations, reviews };
}

test("direct gate calls preserve authorization decisions and inputs across placement values", async () => {
  const scenarios: Array<{ name: string; options: Parameters<typeof runRoute>[1]; expectedReason?: RegExp; expectedReports: string[]; confirmations: number; reviews: number }> = [
    { name: "manual unmatched", options: {}, expectedReports: ["approval-required", "approved"], confirmations: 1, reviews: 0 },
    { name: "deny rule", options: { rules: [baseRule("deny")] }, expectedReason: /Blocked by auto-approval/, expectedReports: ["blocked"], confirmations: 0, reviews: 0 },
    { name: "ask rule", options: { rules: [baseRule("ask")] }, expectedReports: ["approval-required", "approved"], confirmations: 1, reviews: 0 },
    { name: "manual confirmation denied", options: { rules: [baseRule("ask")], confirm: async () => false }, expectedReason: /user declined/i, expectedReports: ["approval-required", "blocked"], confirmations: 1, reviews: 0 },
    { name: "ordinary allow", options: { command: "danger", rules: [baseRule("allow")] }, expectedReports: ["approved"], confirmations: 0, reviews: 0 },
    { name: "suspicious allow", options: { rules: [baseRule("allow", "global", "danger; echo harmless")] }, expectedReports: ["approval-required", "approved"], confirmations: 1, reviews: 0 },
    { name: "untrusted project allow", options: { rules: [baseRule("allow", "project", "danger; echo harmless")], trusted: false }, expectedReports: ["approval-required", "approved"], confirmations: 1, reviews: 0 },
    { name: "review approve", options: { mode: "auto", review: async () => ({ ok: true, verdict: { decision: "approve", reason: "safe" } }) }, expectedReports: ["guardian-running", "approved"], confirmations: 0, reviews: 1 },
    { name: "review revise", options: { mode: "auto", review: async () => ({ ok: true, verdict: { decision: "revise", reason: "change target" } }) }, expectedReason: /Reviewer requested a revision/, expectedReports: ["guardian-running", "revision-requested"], confirmations: 0, reviews: 1 },
    { name: "aborted call", options: { aborted: true }, expectedReason: /confirmation failed/, expectedReports: [], confirmations: 0, reviews: 0 },
    { name: "review ask_user", options: { mode: "auto", review: async () => ({ ok: true, verdict: { decision: "ask_user", reason: "confirm target" } }) }, expectedReports: ["guardian-running", "approval-required", "approved"], confirmations: 1, reviews: 1 },
    { name: "review failure", options: { mode: "auto", review: async () => ({ ok: false, error: "review failed" }) }, expectedReports: ["guardian-running", "approval-required", "approved"], confirmations: 1, reviews: 1 },
    { name: "review timeout", options: { mode: "auto", review: async () => ({ ok: false, error: "timeout" }) }, expectedReports: ["guardian-running", "approval-required", "approved"], confirmations: 1, reviews: 1 },
    { name: "invalid config", options: { invalid: true }, expectedReason: /invalid config/, expectedReports: [], confirmations: 0, reviews: 0 },
    { name: "explicit off", options: { enabled: false }, expectedReports: [], confirmations: 0, reviews: 0 },
  ];

  for (const scenario of scenarios) {
    const widget = await runRoute("widget", scenario.options);
    const toolRow = await runRoute("toolRow", scenario.options);
    assert.deepEqual(toolRow.decision, widget.decision, `${scenario.name}: decision/reason parity`);
    assert.deepEqual(toolRow.confirmations, widget.confirmations, `${scenario.name}: confirmation title/message parity`);
    assert.deepEqual(toolRow.reviews, widget.reviews, `${scenario.name}: reviewer input parity (including evidence/cache/budget/lineage)`);
    const normalizeReports = (reports: unknown[]) => reports.map((report) => {
      const { ui, ...evidence } = report as { ui: { placement: string }; [key: string]: unknown };
      return { ...evidence, ui: { ...ui, placement: "<placement>" } };
    });
    assert.deepEqual(normalizeReports(toolRow.reports), normalizeReports(widget.reports), `${scenario.name}: full status evidence parity`);
    assert.deepEqual(toolRow.reports.map((entry) => (entry as { state: string }).state), scenario.expectedReports, `${scenario.name}: expected reports`);
    assert.equal(toolRow.confirmations.length, scenario.confirmations, `${scenario.name}: confirmation count`);
    assert.equal(toolRow.reviews.length, scenario.reviews, `${scenario.name}: reviewer count`);
    assert.deepEqual(toolRow.reports.map((entry) => (entry as { state: string }).state), widget.reports.map((entry) => (entry as { state: string }).state), `${scenario.name}: state parity`);
    if (scenario.expectedReason) assert.match(String((toolRow.decision as { reason?: string } | undefined)?.reason), scenario.expectedReason, scenario.name);
  }
});
