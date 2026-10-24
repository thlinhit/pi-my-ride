import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, loadGlobalConfig, saveGlobalSettings } from "./config.ts";
import type { ConfigResult, PermissionSettings, ReviewerConfig, SessionChoices } from "./config.ts";
import { footerText } from "./ui/footer.ts";
import { permissionsMenu, type MenuResult } from "./ui/permissions-menu.ts";

const USE_ACTIVE_MODEL = "Use active model";
export interface PermissionsController {
  snapshot(): SessionChoices;
  menu(args: string, ctx: ExtensionCommandContext): Promise<void>;
  reset(ctx: ExtensionContext): void;
  close(): void;
  refreshFooter(ctx: ExtensionContext): void;
}
export function createPermissionsController(globalDir: string, cancelPending: () => void, clearDisplay: (ctx: ExtensionContext) => void = () => {}): PermissionsController {
  let choices: SessionChoices = {};
  let locked = false;
  let generation = 0;
  let dismiss: (() => void) | undefined;
  const notify = (ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info") => { try { ctx.ui.notify(message, type); } catch {} };
  const settings = (saved: ConfigResult): PermissionSettings => ({ enabled: choices.enabled ?? (saved.ok ? saved.enabled : true), reviewMode: choices.reviewMode ?? (saved.ok ? saved.reviewMode : "manual"), debug: choices.debug ?? (saved.ok ? saved.debug : false) });
  const reviewer = (saved: ConfigResult) => choices.reviewerModel === undefined ? (saved.ok ? saved.reviewer.model : undefined) : choices.reviewerModel ?? undefined;
  const reviewerLabel = (ctx: ExtensionContext, saved: ConfigResult) => {
    const model = reviewer(saved);
    return model ? `${model.provider}/${model.id}` : `active model${ctx.model ? ` (${ctx.model.provider}/${ctx.model.id})` : ""}`;
  };
  const close = () => { generation++; dismiss?.(); dismiss = undefined; };
  const chooseReviewerModel = async (ctx: ExtensionCommandContext, openedAt: number): Promise<void> => {
    const saved = loadConfig(ctx.cwd, globalDir);
    if (!saved.ok) { notify(ctx, `Saved config is invalid: ${saved.error}`, "error"); return; }
    let models: { readonly provider: string; readonly id: string }[];
    try { models = ctx.modelRegistry.getAvailable(); } catch (err) { notify(ctx, `Could not list models: ${(err as Error).message}`, "error"); return; }
    const pairs = new Map<string, NonNullable<ReviewerConfig["model"]>>();
    const labels = models.map((model, index) => {
      const label = `${index + 1}. ${model.provider}/${model.id}`;
      pairs.set(label, { provider: model.provider, id: model.id }); return label;
    });
    const selected = await ctx.ui.select(`Reviewer model (current: ${reviewerLabel(ctx, saved)})`, [USE_ACTIVE_MODEL, ...labels]);
    if (selected === undefined || openedAt !== generation) return;
    const model = selected === USE_ACTIVE_MODEL ? null : pairs.get(selected);
    if (model === undefined) { notify(ctx, `Unknown reviewer model: ${selected}`, "warning"); return; }
    choices = { ...choices, reviewerModel: model };
  };
  const refreshFooter = (ctx: ExtensionContext): void => {
    try {
      if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
      ctx.ui.setStatus("auto-approval", footerText(loadConfig(ctx.cwd, globalDir), choices));
    } catch {}
  };
  return {
    refreshFooter, close,
    snapshot: () => ({ ...choices }),
    async menu(args, ctx) {
      if (args.trim()) { notify(ctx, "/permissions does not accept arguments", "warning"); refreshFooter(ctx); return; }
      if (!ctx.hasUI || ctx.mode !== "tui") { notify(ctx, "/permissions requires an interactive TUI", "warning"); refreshFooter(ctx); return; }
      if (locked) { notify(ctx, "/permissions menu is already open", "warning"); refreshFooter(ctx); return; }
      locked = true;
      const openedAt = generation;
      let index = 0;
      try {
        while (openedAt === generation) {
          const combined = loadConfig(ctx.cwd, globalDir);
          const saved = combined.ok ? combined : loadGlobalConfig(globalDir);
          const current = settings(saved);
          const labels = [`Permission: ${current.enabled ? "on" : "off"}`, `Review mode: ${current.reviewMode}`, `Reviewer model: ${reviewerLabel(ctx, saved)}`, `Debug: ${current.debug ? "on" : "off"}`];
          let result: MenuResult;
          try {
            result = await ctx.ui.custom<MenuResult>((tui, theme, keys, done) => {
              const finish = (value: MenuResult) => { dismiss = undefined; done(value); };
              dismiss = () => finish({ action: "close", index });
              return permissionsMenu(labels, index, combined.ok ? undefined : combined.error)(tui, theme, keys, finish);
            });
          } finally { dismiss = undefined; }
          if (openedAt !== generation || !result || result.action === "close") break;
          index = result.index;
          if (result.action === "activate" && index === 2) { await chooseReviewerModel(ctx, openedAt); if (openedAt === generation) refreshFooter(ctx); continue; }
          // Compare effective protection/mode using one fresh saved snapshot at action time.
          const actionConfig = loadConfig(ctx.cwd, globalDir);
          const global = actionConfig.ok ? actionConfig : loadGlobalConfig(globalDir);
          const before = settings(global);
          const beforeChoices = choices;
          if (result.action === "save") {
            if (!global.ok) { notify(ctx, `Could not save settings to ${globalDir}/auto-permissions.json: ${global.error}`, "error"); continue; }
            const saved = saveGlobalSettings(globalDir, before, reviewer(global) ?? null);
            notify(ctx, saved.ok ? `Saved settings to ${saved.path}` : `Could not save settings to ${saved.path}: ${saved.error}`, saved.ok ? "info" : "error");
            const combined = loadConfig(ctx.cwd, globalDir);
            if (!combined.ok) notify(ctx, choices.enabled === false ? `Protection is explicitly off; config remains invalid: ${combined.error}` : `Tools remain blocked by config: ${combined.error}`, "error");
          } else {
            if (result.action === "reset") { choices = {}; clearDisplay(ctx); }
            else if (index === 0) choices = { ...choices, enabled: !before.enabled };
            else if (index === 1) choices = { ...choices, reviewMode: before.reviewMode === "auto" ? "manual" : "auto" };
            else if (index === 3) { choices = { ...choices, debug: !before.debug }; if (before.debug) clearDisplay(ctx); }
            const after = settings(global);
            const changed = beforeChoices.enabled !== choices.enabled || beforeChoices.reviewMode !== choices.reviewMode;
            if (actionConfig.ok ? before.enabled !== after.enabled || before.reviewMode !== after.reviewMode : changed) cancelPending();
            const invalid = !actionConfig.ok && choices.enabled !== false;
            notify(ctx, `Protection ${after.enabled ? "on" : "off"} · ${after.reviewMode}${invalid ? " · invalid config still blocks tools" : ""}`, invalid ? "error" : "info");
          }
          refreshFooter(ctx);
        }
      } catch (err) { if (openedAt === generation) notify(ctx, `Could not open /permissions: ${(err as Error).message}`, "error"); }
      finally { dismiss = undefined; if (openedAt === generation) refreshFooter(ctx); locked = false; }
    },
    reset(ctx) {
      choices = {}; clearDisplay(ctx); close(); cancelPending();
      const result = loadConfig(ctx.cwd, globalDir);
      notify(ctx, result.ok ? `Protection ${result.enabled ? "on" : "off"} · ${result.reviewMode}` : `Saved config is invalid: ${result.error}`, result.ok ? "info" : "error");
      refreshFooter(ctx);
    },
  };
}
