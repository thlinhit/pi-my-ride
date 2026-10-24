import type { ConfigResult, SessionChoices } from "../config.ts";

export function footerText(config: ConfigResult, choices: SessionChoices): string | undefined {
  if (!config.ok) {
    if (choices.enabled === false) return "🛡️ off";
    return "⚠ protection config error · tools blocked";
  }

  if (!config.ui.status) return undefined;

  const enabled = choices.enabled ?? config.enabled;
  const reviewMode = choices.reviewMode ?? config.reviewMode;
  return enabled ? `🛡️ ${reviewMode}` : "🛡️ off";
}
