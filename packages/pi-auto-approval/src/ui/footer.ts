import type { ConfigResult, SessionChoices } from "../config.ts";

export function footerText(config: ConfigResult, choices: SessionChoices): string | undefined {
  if (!config.ok) {
    if (choices.enabled === false) return "🛡️ guardian: off";
    return "⚠ protection config error · Bash blocked";
  }

  if (!config.ui.status) return undefined;

  const enabled = choices.enabled ?? config.enabled;
  const reviewMode = choices.reviewMode ?? config.reviewMode;
  return enabled ? `🛡️ guardian: ${reviewMode}` : "🛡️ guardian: off";
}
