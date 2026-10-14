import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, loadGlobalConfig, saveGlobalSettings } from "./config.ts";
import type { ConfigUi, PermissionSettings, SessionChoices } from "./config.ts";
import { footerText } from "./ui/footer.ts";

const OPTIONS = ["Protection on", "Protection off", "Auto review", "Manual review", "Save settings", "Clear session choices / reload"];
export interface PermissionsController {
  snapshot(): SessionChoices;
  menu(args: string, ctx: ExtensionCommandContext): Promise<void>;
  reset(ctx: ExtensionContext): void;
  refreshFooter(ctx: ExtensionContext): void;
}
export function createPermissionsController(globalDir: string, cancelPending: () => void): PermissionsController {
  let choices: SessionChoices = {};
  let locked = false;
  let generation = 0;
  const notify = (ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info") => { try { ctx.ui.notify(message, type); } catch {} };
  const loadSettings = (ctx: ExtensionContext, saved = loadConfig(ctx.cwd, globalDir)): PermissionSettings | undefined => {
    return saved.ok ? { enabled: choices.enabled ?? saved.enabled, reviewMode: choices.reviewMode ?? saved.reviewMode } : undefined;
  };
  const snapshot = (): SessionChoices => ({ ...choices });
  const refreshFooter = (ctx: ExtensionContext): void => {
    try {
      if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
      const saved = loadConfig(ctx.cwd, globalDir);
      ctx.ui.setStatus("auto-approval", footerText(saved, choices));
    } catch {}
  };
  return {
    refreshFooter,

    snapshot,
    async menu(args, ctx) {
      if (args.trim()) { notify(ctx, "/permissions does not accept arguments", "warning"); refreshFooter(ctx); return; }
      if (!ctx.hasUI) { notify(ctx, "/permissions requires an interactive UI", "warning"); refreshFooter(ctx); return; }
      if (locked) { notify(ctx, "/permissions menu is already open", "warning"); refreshFooter(ctx); return; }
      locked = true;
      const openedAt = generation;
      try {
        const selected = await ctx.ui.select("Permissions", OPTIONS);
        if (selected === undefined || openedAt !== generation) { refreshFooter(ctx); return; }
        const saved = loadConfig(ctx.cwd, globalDir);
        const beforeChoices = choices;
        const before = loadSettings(ctx, saved);
        if (selected === "Protection on") choices = { ...choices, enabled: true };
        else if (selected === "Protection off") choices = { ...choices, enabled: false };
        else if (selected === "Auto review") choices = { ...choices, reviewMode: "auto" };
        else if (selected === "Manual review") choices = { ...choices, reviewMode: "manual" };
        else if (selected === "Clear session choices / reload") {
          const hadChoices = Object.keys(choices).length > 0;
          choices = {};
          const after = loadSettings(ctx, saved);
          if (before && after && (before.enabled !== after.enabled || before.reviewMode !== after.reviewMode)) cancelPending();
          else if (hadChoices && !before) cancelPending();
          const result = loadConfig(ctx.cwd, globalDir);
          notify(ctx, result.ok ? `Protection ${result.enabled ? "on" : "off"} · ${result.reviewMode}` : `Saved config is invalid: ${result.error}`, result.ok ? "info" : "error");
          return;
        } else if (selected === "Save settings") {
          const global = loadGlobalConfig(globalDir);
          if (!global.ok) { notify(ctx, `Could not save settings to ${globalDir}/auto-permissions.json: ${global.error}`, "error"); return; }
          const settings = { enabled: choices.enabled ?? global.enabled, reviewMode: choices.reviewMode ?? global.reviewMode };
          const result = saveGlobalSettings(globalDir, settings);
          notify(ctx, result.ok ? `Saved settings to ${result.path}` : `Could not save settings to ${result.path}: ${result.error}`, result.ok ? "info" : "error");
          const combined = loadConfig(ctx.cwd, globalDir);
          if (!combined.ok) notify(ctx, choices.enabled === false ? `Protection is explicitly off; config remains invalid: ${combined.error}` : `Bash remains blocked by config: ${combined.error}`, "error");
          return;
        } else return;
        const after = loadSettings(ctx, saved);
        const changed = beforeChoices.enabled !== choices.enabled || beforeChoices.reviewMode !== choices.reviewMode;
        if (before && after && (before.enabled !== after.enabled || before.reviewMode !== after.reviewMode)) cancelPending();
        else if (!before && changed) cancelPending();
        const effective = after ?? { enabled: choices.enabled ?? (saved.ok ? saved.enabled : true), reviewMode: choices.reviewMode ?? (saved.ok ? saved.reviewMode : "manual") };
        const invalid = !saved.ok && !(choices.enabled === false);
        notify(ctx, `Protection ${effective.enabled ? "on" : "off"} · ${effective.reviewMode}${invalid ? " · invalid config still blocks Bash" : ""}`, invalid ? "error" : "info");
      } catch (err) { notify(ctx, `Could not open /permissions: ${(err as Error).message}`, "error"); }
      finally { refreshFooter(ctx); locked = false; }
    },
    reset(ctx) {
      choices = {};
      generation++;
      cancelPending();
      try {
        const result = loadConfig(ctx.cwd, globalDir);
        notify(ctx, result.ok ? `Protection ${result.enabled ? "on" : "off"} · ${result.reviewMode}` : `Saved config is invalid: ${result.error}`, result.ok ? "info" : "error");
      } catch {}
      refreshFooter(ctx);
    },
  };
}
