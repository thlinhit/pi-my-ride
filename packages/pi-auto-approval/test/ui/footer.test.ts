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

test("shows compact guardian modes", () => {
  assert.equal(footerText(valid(), choices()), "🛡️ guardian: manual");
  assert.equal(footerText(valid({ reviewMode: "auto" }), choices()), "🛡️ guardian: auto");
});

test("shows off regardless of configured review mode", () => {
  assert.equal(footerText(valid({ enabled: false, reviewMode: "manual" }), choices()), "🛡️ guardian: off");
  assert.equal(footerText(valid({ enabled: false, reviewMode: "auto" }), choices()), "🛡️ guardian: off");
});

test("uses session choices over valid config", () => {
  assert.equal(footerText(valid({ reviewMode: "auto" }), choices({ enabled: false, reviewMode: "manual" })), "🛡️ guardian: off");
  assert.equal(footerText(valid({ enabled: false, reviewMode: "manual" }), choices({ enabled: true, reviewMode: "auto" })), "🛡️ guardian: auto");
  assert.equal(footerText(valid({ reviewMode: "auto" }), choices({ reviewMode: "manual" })), "🛡️ guardian: manual");
});

test("suppresses valid status when ui status is disabled", () => {
  assert.equal(footerText(valid({ ui: { status: false, placement: "widget" } }), choices()), undefined);
  assert.equal(footerText(valid({ ui: { status: false, placement: "widget" } }), choices({ enabled: false })), undefined);
});

test("invalid config shows error unless session protection is explicitly off", () => {
  const invalid: ConfigResult = { ok: false, error: "bad config" };
  assert.equal(footerText(invalid, choices()), "⚠ protection config error · tools blocked");
  assert.equal(footerText(invalid, choices({ enabled: false })), "🛡️ guardian: off");
  assert.equal(footerText(invalid, choices({ enabled: false, reviewMode: "auto" })), "🛡️ guardian: off");
  assert.equal(footerText(invalid, choices({ enabled: false, reviewMode: "manual" })), "🛡️ guardian: off");
});
