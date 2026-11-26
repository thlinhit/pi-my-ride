import type { ConfigResult, loadConfig, PermissionSettings, SessionChoices } from "../config.ts";

type LoadedConfig = Extract<ReturnType<typeof loadConfig>, { ok: true }>;
export type PermissionConfig = ConfigResult & Partial<Pick<LoadedConfig, "global" | "project">>;

export function effectiveSettings(
  config: PermissionConfig | undefined,
  choices: SessionChoices,
  trusted: boolean,
): PermissionSettings {
  const local = trusted && config?.ok ? config.project?.local?.settings : undefined;
  const shared = trusted && config?.ok ? config.project?.shared?.settings : undefined;
  const global = config?.ok ? (config.global ?? config) : undefined;
  return {
    enabled: choices.enabled ?? local?.enabled ?? shared?.enabled ?? global?.enabled ?? true,
    reviewMode: choices.reviewMode ?? local?.reviewMode ?? shared?.reviewMode ?? global?.reviewMode ?? "manual",
    debug: choices.debug ?? global?.debug ?? false,
  };
}

export function footerText(
  config: PermissionConfig | undefined,
  choices: SessionChoices,
  settings = effectiveSettings(config, choices, false),
): string | undefined {
  if (!config?.ok) {
    if (choices.enabled === false) return "🛡️ off";
    return "⚠ protection config error · tools blocked";
  }

  if (!config.ui.status) return undefined;

  return settings.enabled ? `🛡️ ${settings.reviewMode}` : "🛡️ off";
}
