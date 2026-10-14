import assert from "node:assert/strict";
import test from "node:test";
import { footerText } from "../../src/ui/footer.ts";
import type { ConfigResult, SessionChoices } from "../../src/config.ts";

const valid = (overrides: Partial<Extract<ConfigResult, { ok: true }>> = {}): Extract<ConfigResult, { ok: true }> => ({
  ok: true,
  enabled: true,
  reviewMode: "manual",
  rules: [],
  reviewer: { reasoningEffort: "low", timeoutMs: 30_000 },
  reviewEvidence: { projectInstructions: false },
  ui: { status: true, placement: "widget" },
  ...overrides,
});

const choices = (overrides: SessionChoices = {}): SessionChoices => overrides;

test("uses session choices over valid config", () => {
  assert.equal(footerText(valid(), choices()), "▸▸ protection on · manual");
  assert.equal(footerText(valid({ reviewMode: "auto" }), choices({ enabled: false, reviewMode: "manual" })), "⏸ protection off · manual");
  assert.equal(footerText(valid({ enabled: false, reviewMode: "manual" }), choices({ enabled: true, reviewMode: "auto" })), "▸▸ protection on · auto");
  assert.equal(footerText(valid({ enabled: false, reviewMode: "auto" }), choices()), "⏸ protection off · auto");
});

test("suppresses valid status when ui status is disabled", () => {
  assert.equal(footerText(valid({ ui: { status: false, placement: "widget" } }), choices()), undefined);
  assert.equal(footerText(valid({ ui: { status: false, placement: "widget" } }), choices({ enabled: false })), undefined);
});

test("invalid config shows error unless session protection is explicitly off", () => {
  const invalid: ConfigResult = { ok: false, error: "bad config" };
  assert.equal(footerText(invalid, choices()), "⚠ protection config error · Bash blocked");
  assert.equal(footerText(invalid, choices({ enabled: false })), "⏸ protection off");
  assert.equal(footerText(invalid, choices({ enabled: false, reviewMode: "auto" })), "⏸ protection off · auto");
});
