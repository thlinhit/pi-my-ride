import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ConfigResult, Rule } from "./config.ts";
import { loadConfig, loadTrustedGroups } from "./config.ts";
import { isTrusted, matchRule } from "./gates.ts";

export interface GateContext {
  readonly cwd: string;
  readonly hasUI: boolean;
  readonly signal: AbortSignal | undefined;
  readonly ui: { confirm(title: string, message: string, opts?: { signal?: AbortSignal }): Promise<boolean> };
}

export type ConfigLoader = (cwd: string) => ConfigResult;

export type GateStatus = "reviewing" | "approved" | "blocked";
export type StatusReporter = (state: GateStatus, label: string) => void;

export interface GateDeps {
  readonly matcher?: (command: string, rules: readonly Rule[]) => Rule | undefined;
  readonly trusted?: (cwd: string) => ReadonlySet<string>;
  readonly status?: StatusReporter;
}

export function createWidgetReporter(
  ui: { setWidget(key: string, content: string[] | undefined): void },
  key: string,
): StatusReporter {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (state, label) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    try {
      ui.setWidget(key, [`auto-approval: ${state} [${label}]`]);
    } catch {}
    if (state !== "reviewing") {
      timer = setTimeout(() => {
        try { ui.setWidget(key, undefined); } catch {}
        timer = undefined;
      }, 2000);
      timer.unref?.();
    }
  };
}

export async function handleToolCall(
  event: { toolName: string; input: unknown },
  ctx: GateContext,
  load: ConfigLoader,
  deps: GateDeps = {},
): Promise<{ block: true; reason: string } | undefined> {
  if (event.toolName !== "bash") return undefined;
  if (ctx.signal?.aborted) return { block: true, reason: "auto-approval: confirmation failed" };
  if (event.input === null || typeof event.input !== "object" || typeof (event.input as { command?: unknown }).command !== "string") {
    return { block: true, reason: "auto-approval: invalid bash input" };
  }
  const command = (event.input as { command: string }).command;
  let config: ConfigResult;
  try {
    config = load(ctx.cwd);
  } catch {
    return { block: true, reason: "auto-approval: config load failed" };
  }
  if (!config.ok) return { block: true, reason: `auto-approval: invalid config - ${config.error}. Fix it to run bash.` };
  let trusted: ReadonlySet<string>;
  try { trusted = (deps.trusted ?? loadTrustedGroups)(ctx.cwd); } catch { trusted = new Set(); }
  if (ctx.signal?.aborted) return { block: true, reason: "auto-approval: confirmation failed" };
  let rule: Rule | undefined;
  try {
    rule = (deps.matcher ?? matchRule)(command, config.rules);
  } catch {
    return { block: true, reason: "auto-approval: matcher error" };
  }
  if (!rule) return undefined;
  const report = (state: GateStatus) => {
    if (!ctx.hasUI || !config.ui.status || !deps.status) return;
    try { deps.status(state, rule!.label); } catch {}
  };
  if (rule.level === "convention") {
    report("blocked");
    return { block: true, reason: rule.message! };
  }
  let trustedMatch = false;
  if (rule.group !== undefined) {
    try { trustedMatch = isTrusted(rule, trusted); } catch { trustedMatch = false; }
  }
  if (trustedMatch) {
    if (ctx.signal?.aborted) return { block: true, reason: `Blocked by auto-approval (${rule.label}): confirmation failed` };
    report("approved");
    if (ctx.signal?.aborted) return { block: true, reason: `Blocked by auto-approval (${rule.label}): confirmation failed` };
    return undefined;
  }
  if (!ctx.hasUI) return { block: true, reason: `Blocked by auto-approval (${rule.label}): no UI to confirm` };
  report("reviewing");
  try {
    const approved = await ctx.ui.confirm(`Approve command? [${rule.label}]`, command, { signal: ctx.signal });
    if (ctx.signal?.aborted) {
      report("blocked");
      return { block: true, reason: `Blocked by auto-approval (${rule.label}): confirmation failed` };
    }
    if (approved === true) {
      report("approved");
      if (ctx.signal?.aborted) {
        report("blocked");
        return { block: true, reason: `Blocked by auto-approval (${rule.label}): confirmation failed` };
      }
      return undefined;
    }
    report("blocked");
    return { block: true, reason: `Blocked by auto-approval (${rule.label}): user declined` };
  } catch {
    report("blocked");
    return { block: true, reason: `Blocked by auto-approval (${rule.label}): confirmation failed` };
  }
}

export default function autoApproval(pi: ExtensionAPI): void {
  let approvalDialogOpened = false;
  let callId = 0;
  pi.on("tool_call", async (event, ctx) => {
    const adapted: GateContext = {
      cwd: ctx.cwd,
      hasUI: ctx.hasUI,
      signal: ctx.signal,
      ui: {
        confirm: async (title, message, opts) => {
          if (approvalDialogOpened) throw new Error("confirmation already in progress");
          approvalDialogOpened = true;
          try {
            return await ctx.ui.confirm(title, message, opts);
          } finally {
            approvalDialogOpened = false;
          }
        },
      },
    };
    const status = createWidgetReporter(ctx.ui, `auto-approval:${++callId}`);
    return handleToolCall(event, adapted, (cwd) => loadConfig(cwd, getAgentDir()), {
      status: (state, label) => {
        if (event.toolName === "bash") status(state, label);
      },
    });
  });
}
