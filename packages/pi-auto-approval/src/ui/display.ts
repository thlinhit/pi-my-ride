import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ConfigUi } from "../config.ts";
import { createRowStore, wrapNativeCall } from "./rows.ts";
import { VERIFIED_PI_VERSIONS } from "./rows.ts";
import type { ReviewStatus } from "./status.ts";
import { isTerminal, widgetLines } from "./status.ts";

export interface ReviewDisplay {
  show(ctx: ExtensionContext, ui: ConfigUi, status: ReviewStatus, widgetKey: string, generation?: number): void;
  generation(): number;
  dropInvalidator(toolCallId: string): void;
  reset(ctx: ExtensionContext): void;
  shutdown(ctx: ExtensionContext): void;
}

const VERSION_WARNING = "Auto Permissions row status is not verified for this Pi version; review status will use the editor widget.";
const BACKEND_WARNING = "Auto Permissions could not verify the builtin bash attribution; review status will use the editor widget.";

export function createReviewDisplay(pi: ExtensionAPI, version: string, verified: readonly string[] = VERIFIED_PI_VERSIONS): ReviewDisplay {
  const store = createRowStore();
  let registered = false;
  let warned = false;
  let builtinAttribution: { source: string; path?: string } | undefined;
  let displayGeneration = 0;
  const routes = new Map<string, "widget" | "toolRow">();
  const terminals = new Set<string>();
  const widgetKeys = new Set<string>();
  const widgetTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const warn = (ctx: ExtensionContext, message: string) => {
    if (warned) return;
    warned = true;
    try { ctx.ui.notify(message, "warning"); } catch {}
  };

  const register = (ctx: ExtensionContext): boolean => {
    if (registered) return true;
    if (ctx.mode !== "tui") return false;
    if (!verified.includes(version)) {
      warn(ctx, VERSION_WARNING);
      return false;
    }
    let bash;
    try { bash = pi.getAllTools().find((tool) => tool.name === "bash"); } catch {
      warn(ctx, BACKEND_WARNING);
      return false;
    }
    if (!bash || bash.sourceInfo.source !== "builtin") {
      warn(ctx, BACKEND_WARNING);
      return false;
    }
    builtinAttribution = { source: bash.sourceInfo.source, path: bash.sourceInfo.path };
    try {
      pi.registerToolRenderer((toolName, next) => {
        const renderers = next();
        if (toolName !== "bash" || !renderers?.renderCall) return renderers;
        return { ...renderers, renderCall: wrapNativeCall(renderers.renderCall, store) };
      });
      registered = true;
      return true;
    } catch {
      warn(ctx, BACKEND_WARNING);
      return false;
    }
  };

  const renderWidget = (ctx: ExtensionContext, status: ReviewStatus, key: string) => {
    widgetKeys.add(key);
    const previousTimer = widgetTimers.get(key);
    if (previousTimer !== undefined) clearTimeout(previousTimer);
    widgetTimers.delete(key);
    try { ctx.ui.setWidget(key, widgetLines(status), { placement: "aboveEditor" }); } catch {}
    if (isTerminal(status.state)) {
      const timer = setTimeout(() => {
        try { ctx.ui.setWidget(key, undefined); } catch {}
        widgetKeys.delete(key);
        widgetTimers.delete(key);
      }, 2000);
      timer.unref?.();
      widgetTimers.set(key, timer);
    }
  };

  return {
    show(ctx, ui, status, widgetKey, generation) {
      if (generation !== undefined && generation !== displayGeneration) return;
      if (!ui.status || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return;
      if (terminals.has(status.toolCallId)) return;
      if (builtinAttribution) {
        let current;
        try {
          current = pi.getAllTools().find((tool) => tool.name === "bash");
        } catch {
          current = undefined;
        }
        if (!current || current.sourceInfo.source !== builtinAttribution.source || current.sourceInfo.path !== builtinAttribution.path) {
          warn(ctx, BACKEND_WARNING);
          renderWidget(ctx, status, widgetKey);
          routes.set(status.toolCallId, "widget");
          if (isTerminal(status.state)) terminals.add(status.toolCallId);
          return;
        }
      }
      let route = routes.get(status.toolCallId);
      if (!route) {
        const canRegister = ui.placement === "toolRow" && register(ctx);
        route = canRegister && store.isReady(status.toolCallId) ? "toolRow" : "widget";
        routes.set(status.toolCallId, route);
      }
      if (route === "toolRow") {
        store.set(status);
      } else {
        renderWidget(ctx, status, widgetKey);
      }
      if (isTerminal(status.state)) terminals.add(status.toolCallId);
    },
    generation() { return displayGeneration; },
    dropInvalidator(toolCallId) { store.dropInvalidator(toolCallId); },
    reset(ctx) {
      displayGeneration += 1;
      routes.clear();
      terminals.clear();
      store.clear();
      for (const timer of widgetTimers.values()) clearTimeout(timer);
      widgetTimers.clear();
      for (const key of widgetKeys) {
        try { ctx.ui.setWidget(key, undefined); } catch {}
      }
      widgetKeys.clear();
      warned = false;
    },
    shutdown(ctx) {
      displayGeneration += 1;
      store.clear();
      for (const timer of widgetTimers.values()) clearTimeout(timer);
      widgetTimers.clear();
      for (const key of widgetKeys) {
        try { ctx.ui.setWidget(key, undefined); } catch {}
      }
      widgetKeys.clear();
      routes.clear();
      terminals.clear();
    },
  };
}

