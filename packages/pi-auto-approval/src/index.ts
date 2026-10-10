import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ConfigResult, Rule } from "./config.ts";
import { loadConfig } from "./config.ts";
import { matchRule } from "./gates.ts";

export interface GateContext {
  readonly cwd: string;
  readonly hasUI: boolean;
  readonly signal: AbortSignal | undefined;
  readonly ui: { confirm(title: string, message: string, opts?: { signal?: AbortSignal }): Promise<boolean> };
}

export type ConfigLoader = (cwd: string) => ConfigResult;

export async function handleToolCall(
  event: { toolName: string; input: unknown },
  ctx: GateContext,
  load: ConfigLoader,
  matcher: (command: string, rules: readonly Rule[]) => Rule | undefined = matchRule,
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
  let rule: Rule | undefined;
  try {
    rule = matcher(command, config.rules);
  } catch {
    return { block: true, reason: "auto-approval: matcher error" };
  }
  if (!rule) return undefined;
  if (rule.level === "convention") return { block: true, reason: rule.message! };
  if (!ctx.hasUI) return { block: true, reason: `Blocked by auto-approval (${rule.label}): no UI to confirm` };
  try {
    const approved = await ctx.ui.confirm(`Approve command? [${rule.label}]`, command, { signal: ctx.signal });
    if (ctx.signal?.aborted) return { block: true, reason: `Blocked by auto-approval (${rule.label}): confirmation failed` };
    return approved === true ? undefined : { block: true, reason: `Blocked by auto-approval (${rule.label}): user declined` };
  } catch {
    return { block: true, reason: `Blocked by auto-approval (${rule.label}): confirmation failed` };
  }
}

export default function autoApproval(pi: ExtensionAPI): void {
  let confirming = false;
  pi.on("tool_call", async (event, ctx) => {
    const adapted: GateContext = {
      cwd: ctx.cwd,
      hasUI: ctx.hasUI,
      signal: ctx.signal,
      ui: {
        confirm: async (title, message, opts) => {
          if (confirming) throw new Error("confirmation already in progress");
          confirming = true;
          try {
            return await ctx.ui.confirm(title, message, opts);
          } finally {
            confirming = false;
          }
        },
      },
    };
    return handleToolCall(event, adapted, (cwd) => loadConfig(cwd, getAgentDir()));
  });
}
