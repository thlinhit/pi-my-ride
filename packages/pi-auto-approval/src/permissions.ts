import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, loadGlobalConfig, saveGlobalReviewerModel, saveGlobalSettings } from "./config.ts";
import type { ConfigUi, PermissionSettings, ReviewerConfig, SessionChoices } from "./config.ts";
import { footerText } from "./ui/footer.ts";

const OPTIONS = ["Protection on", "Protection off", "Auto review", "Manual review", "Reviewer model", "Save settings", "Clear session choices / reload"];
const USE_ACTIVE_MODEL = "Use active model";
export interface PermissionsController {
  snapshot(): SessionChoices;
  menu(args: string, ctx: ExtensionCommandContext): Promise<void>;
  reset(ctx: ExtensionContext): void;
  refreshFooter(ctx: ExtensionContext): void;
}
export function createPermissionsController(globalDir: string, cancelPending: () => void, clearDisplay: (ctx: ExtensionContext) => void = () => {}): PermissionsController {
  let choices: SessionChoices = {};
  let locked = false;
  let generation = 0;
  const notify = (ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info") => { try { ctx.ui.notify(message, type); } catch {} };
  const loadSettings = (ctx: ExtensionContext, saved = loadConfig(ctx.cwd, globalDir)): PermissionSettings | undefined => {
    return saved.ok ? { enabled: choices.enabled ?? saved.enabled, reviewMode: choices.reviewMode ?? saved.reviewMode, debug: choices.debug ?? saved.debug } : undefined;
  };
  const snapshot = (): SessionChoices => ({ ...choices });
  const chooseReviewerModel = async (ctx: ExtensionCommandContext, openedAt: number): Promise<void> => {
    const saved = loadConfig(ctx.cwd, globalDir);
    if (!saved.ok) { notify(ctx, `Saved config is invalid: ${saved.error}`, "error"); return; }
    let models: { readonly provider: string; readonly id: string }[];
    try { models = ctx.modelRegistry.getAvailable(); } catch (err) { notify(ctx, `Could not list models: ${(err as Error).message}`, "error"); return; }
    const pairs = new Map<string, NonNullable<ReviewerConfig["model"]>>();
    const labels = models.map((model, index) => {
      const label = `${index + 1}. ${model.provider}/${model.id}`;
      pairs.set(label, { provider: model.provider, id: model.id });
      return label;
    });
    const current = saved.reviewer.model ? `${saved.reviewer.model.provider}/${saved.reviewer.model.id}` : "active model";
    const selected = await ctx.ui.select(`Reviewer model (current: ${current})`, [USE_ACTIVE_MODEL, ...labels]);
    if (selected === undefined || openedAt !== generation) return;
    const clear = selected === USE_ACTIVE_MODEL;
    const model = clear ? undefined : pairs.get(selected);
    if (!clear && !model) { notify(ctx, `Unknown reviewer model: ${selected}`, "warning"); return; }
    const result = saveGlobalReviewerModel(globalDir, model);
    if (!result.ok) notify(ctx, `Could not save reviewer model to ${result.path}: ${result.error}; previous selection retained`, "error");
    else if (model) notify(ctx, `Saved reviewer model ${model.provider}/${model.id} to ${result.path}`, "info");
    else notify(ctx, "Reviewer model: active model (global override cleared)", "info");
  };
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
        const debugConfig = loadGlobalConfig(globalDir);
        const debug = choices.debug ?? (debugConfig.ok ? debugConfig.debug : false);
        const debugOption = `Debug: ${debug ? "on" : "off"}`;
        const selected = await ctx.ui.select("Permissions", [...OPTIONS.slice(0, 5), debugOption, ...OPTIONS.slice(5)]);
        if (selected === undefined || openedAt !== generation) { refreshFooter(ctx); return; }
        if (selected === "Reviewer model") { await chooseReviewerModel(ctx, openedAt); return; }
        const saved = loadConfig(ctx.cwd, globalDir);
        const beforeChoices = choices;
        const before = loadSettings(ctx, saved);
        if (selected === debugOption) {
          choices = { ...choices, debug: !debug };
          if (debug) clearDisplay(ctx);
          return;
        }
        if (selected === "Protection on") choices = { ...choices, enabled: true };
        else if (selected === "Protection off") choices = { ...choices, enabled: false };
        else if (selected === "Auto review") choices = { ...choices, reviewMode: "auto" };
        else if (selected === "Manual review") choices = { ...choices, reviewMode: "manual" };
        else if (selected === "Clear session choices / reload") {
          const hadChoices = choices.enabled !== undefined || choices.reviewMode !== undefined;
          choices = {};
          const after = loadSettings(ctx, saved);
          if (before && after && (before.enabled !== after.enabled || before.reviewMode !== after.reviewMode)) cancelPending();
          else if (hadChoices && !before) cancelPending();
          clearDisplay(ctx);
          const result = loadConfig(ctx.cwd, globalDir);
          notify(ctx, result.ok ? `Protection ${result.enabled ? "on" : "off"} · ${result.reviewMode}` : `Saved config is invalid: ${result.error}`, result.ok ? "info" : "error");
          return;
        } else if (selected === "Save settings") {
          const global = loadGlobalConfig(globalDir);
          if (!global.ok) { notify(ctx, `Could not save settings to ${globalDir}/auto-permissions.json: ${global.error}`, "error"); return; }
          const settings = { enabled: choices.enabled ?? global.enabled, reviewMode: choices.reviewMode ?? global.reviewMode, debug: choices.debug ?? global.debug };
          const result = saveGlobalSettings(globalDir, settings);
          notify(ctx, result.ok ? `Saved settings to ${result.path}` : `Could not save settings to ${result.path}: ${result.error}`, result.ok ? "info" : "error");
          const combined = loadConfig(ctx.cwd, globalDir);
          if (!combined.ok) notify(ctx, choices.enabled === false ? `Protection is explicitly off; config remains invalid: ${combined.error}` : `Tools remain blocked by config: ${combined.error}`, "error");
          return;
        } else return;
        const after = loadSettings(ctx, saved);
        const changed = beforeChoices.enabled !== choices.enabled || beforeChoices.reviewMode !== choices.reviewMode;
        if (before && after && (before.enabled !== after.enabled || before.reviewMode !== after.reviewMode)) cancelPending();
        else if (!before && changed) cancelPending();
        const effective = after ?? { enabled: choices.enabled ?? (saved.ok ? saved.enabled : true), reviewMode: choices.reviewMode ?? (saved.ok ? saved.reviewMode : "manual") };
        const invalid = !saved.ok && !(choices.enabled === false);
        notify(ctx, `Protection ${effective.enabled ? "on" : "off"} · ${effective.reviewMode}${invalid ? " · invalid config still blocks tools" : ""}`, invalid ? "error" : "info");
      } catch (err) { notify(ctx, `Could not open /permissions: ${(err as Error).message}`, "error"); }
      finally { refreshFooter(ctx); locked = false; }
    },
    reset(ctx) {
      choices = {};
      clearDisplay(ctx);
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
