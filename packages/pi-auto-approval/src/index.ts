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

export type GateDecision = { block: true; reason: string } | undefined;

const CONFIRMATION_FAILED = "auto-approval: confirmation failed";

const block = (reason: string): { block: true; reason: string } => ({ block: true, reason });
const blockByRule = (rule: Rule, why: string): { block: true; reason: string } =>
  block(`Blocked by auto-approval (${rule.label}): ${why}`);

function bashCommandOf(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const { command } = input as { command?: unknown };
  return typeof command === "string" ? command : undefined;
}

function loadTrustedOrNone(deps: GateDeps, cwd: string): ReadonlySet<string> {
  try {
    return (deps.trusted ?? loadTrustedGroups)(cwd);
  } catch {
    return new Set();
  }
}

function isRuleTrusted(rule: Rule, trusted: ReadonlySet<string>): boolean {
  if (rule.group === undefined) return false;
  try {
    return isTrusted(rule, trusted);
  } catch {
    return false;
  }
}

async function confirmWithUser(
  rule: Rule,
  command: string,
  ctx: GateContext,
  report: (state: GateStatus) => void,
): Promise<GateDecision> {
  report("reviewing");
  try {
    const approved = await ctx.ui.confirm(`Approve command? [${rule.label}]`, command, { signal: ctx.signal });
    if (ctx.signal?.aborted) {
      report("blocked");
      return blockByRule(rule, "confirmation failed");
    }
    if (approved !== true) {
      report("blocked");
      return blockByRule(rule, "user declined");
    }
    report("approved");
    if (ctx.signal?.aborted) {
      report("blocked");
      return blockByRule(rule, "confirmation failed");
    }
    return undefined;
  } catch {
    report("blocked");
    return blockByRule(rule, "confirmation failed");
  }
}

export async function handleToolCall(
  event: { toolName: string; input: unknown },
  ctx: GateContext,
  load: ConfigLoader,
  deps: GateDeps = {},
): Promise<GateDecision> {
  if (event.toolName !== "bash") return undefined;
  if (ctx.signal?.aborted) return block(CONFIRMATION_FAILED);

  const command = bashCommandOf(event.input);
  if (command === undefined) return block("auto-approval: invalid bash input");

  let config: ConfigResult;
  try {
    config = load(ctx.cwd);
  } catch {
    return block("auto-approval: config load failed");
  }
  if (!config.ok) return block(`auto-approval: invalid config - ${config.error}. Fix it to run bash.`);

  const trusted = loadTrustedOrNone(deps, ctx.cwd);
  if (ctx.signal?.aborted) return block(CONFIRMATION_FAILED);

  let matched: Rule | undefined;
  try {
    matched = (deps.matcher ?? matchRule)(command, config.rules);
  } catch {
    return block("auto-approval: matcher error");
  }
  if (!matched) return undefined;
  const rule = matched;

  const report = (state: GateStatus) => {
    if (!ctx.hasUI || !config.ui.status || !deps.status) return;
    try { deps.status(state, rule.label); } catch {}
  };

  if (rule.level === "convention") {
    report("blocked");
    return block(rule.message!);
  }

  if (isRuleTrusted(rule, trusted)) {
    if (ctx.signal?.aborted) return blockByRule(rule, "confirmation failed");
    report("approved");
    if (ctx.signal?.aborted) return blockByRule(rule, "confirmation failed");
    return undefined;
  }

  if (!ctx.hasUI) return blockByRule(rule, "no UI to confirm");
  return confirmWithUser(rule, command, ctx, report);
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
