import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { VERSION } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PermissionRule, SessionChoices } from "./config.ts";
import {
  CONFIG_FILENAME,
  ensureGlobalConfig,
  globalConfigDir,
  loadConfig,
  projectConfigPath,
  resolveReviewerPolicy,
} from "./config.ts";
import { inspectShell } from "./harddeny.ts";
import { analyzeShell } from "./shell.ts";
import { isReadOnlyComponent } from "./readonly.ts";
import { matchPermission, matchPermissionExact, resolveToolPath } from "./rules.ts";
import { foldPath, isPathInsideOrEqual, resolvePathForPolicy } from "./paths.ts";
import { createPermissionsController, isTrustedProject } from "./permissions.ts";
import { effectiveSettings, type PermissionConfig } from "./ui/footer.ts";
import { recordHistory, type HistoryBy, type HistoryEntry, type HistoryResult } from "./history.ts";
import { createReviewDisplay } from "./ui/display.ts";
import type { ConfigUi } from "./config.ts";
import type { ReviewState } from "./ui/status.ts";
import type { ReviewInput, ReviewResult, Reviewer } from "./review/session.ts";
import { createPiReviewer, createReviewerState } from "./review/session.ts";

export type { ReviewContext, ReviewInput, ReviewResult, Reviewer, ReviewerState } from "./review/session.ts";
export { createPiReviewer, createReviewerState } from "./review/session.ts";
export interface GateContext {
  readonly cwd: string;
  readonly hasUI: boolean;
  readonly signal: AbortSignal | undefined;
  isProjectTrusted(): boolean;
  readonly ui: {
    confirm(title: string, message: string, opts?: { signal?: AbortSignal }): Promise<boolean>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}
export type ConfigLoader = (cwd: string) => PermissionConfig;
export interface GateReport {
  readonly state: ReviewState;
  readonly label: string;
  readonly source?: string;
  readonly reviewer?: string;
  readonly detail?: string;
  readonly ui: ConfigUi;
}
export type StatusReporter = (report: GateReport) => void;
export interface GateDeps {
  readonly matcher?: (
    call: { toolName: string; input: unknown },
    cwd: string,
    rules: readonly PermissionRule[],
    projectTrusted: boolean,
  ) => PermissionRule | undefined;
  readonly status?: StatusReporter;
  readonly reviewer?: string;
  readonly review?: Reviewer;
  readonly history?: (entry: HistoryEntry) => HistoryResult;
}
export type GateStatus = ReviewState;
export type GateDecision = { block: true; reason: string } | undefined;
const CONFIRMATION_FAILED = "auto-approval: confirmation failed";
const MAX_BASH_APPROVAL_BYTES = 65_536;
const block = (reason: string): { block: true; reason: string } => ({ block: true, reason });
const blockSources = {
  hardDeny: "hard deny",
  denyRule: "deny rule",
  protectedPath: "protected path",
  reviewer: "reviewer",
  noUI: "no UI",
  user: "user",
  config: "config",
  error: "error",
  cancelled: "cancelled",
} as const;
type BlockSource = keyof typeof blockSources;
function blocked(source: BlockSource, reason: string) {
  return block(
    `Blocked by auto-approval (${blockSources[source]}): ${reason}\nThe tool did not run. Do not claim it succeeded. You may take a different approach that stays within policy, but do not retry this action another way (other syntax, another tool, or a script).`,
  );
}
type Verdict = { readonly decision: GateDecision; readonly by: HistoryBy; readonly reason?: string };
const passed = (by: HistoryBy, reason?: string): Verdict => ({
  decision: undefined,
  by,
  ...(reason ? { reason } : {}),
});
const stop = (by: HistoryBy, source: BlockSource, reason: string): Verdict => {
  const decision = blocked(source, reason);
  return { decision, by, reason: decision.reason };
};
const cancelled = (reason: string): Verdict => stop("cancelled", "cancelled", reason);
const invalidVerdict = (_: never) => stop("reviewer", "reviewer", "Invalid verdict");
type GateOutcome = { kind: "not-gated" } | ({ kind: "decided"; log: boolean } & Verdict);
const NOT_GATED: GateOutcome = { kind: "not-gated" };
const PATH_TOOLS = new Set(["read", "edit", "write"]);
function historyCommandOf(toolName: string, input: unknown): string {
  const value =
    input !== null && typeof input === "object"
      ? (input as Record<string, unknown>)[PATH_TOOLS.has(toolName) ? "path" : "command"]
      : undefined;
  return typeof value === "string" ? value : "";
}
function bashCommandOf(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const { command } = input as { command?: unknown };
  return typeof command === "string" ? command : undefined;
}
const EXCERPT_LIMIT = 2000;
function callExcerpt(toolName: string, input: unknown): string {
  const json = JSON.stringify(input) ?? String(input);
  return `${toolName} ${json.length > EXCERPT_LIMIT ? `${json.slice(0, EXCERPT_LIMIT)}...` : json}`;
}
function safeNotify(ctx: GateContext, message: string): void {
  try {
    ctx.ui.notify(message);
  } catch {}
}
function isAborted(ctx: GateContext): boolean {
  return ctx.signal?.aborted === true;
}
function snapshotGate(ctx: GateContext, choices: SessionChoices, load?: ConfigLoader, globalDir = globalConfigDir()) {
  let config: PermissionConfig | undefined;
  try {
    config = load?.(ctx.cwd);
  } catch {}
  const projectTrusted = isTrustedProject(ctx);
  return { config, globalDir, projectTrusted, settings: effectiveSettings(config, choices, projectTrusted) };
}

function recordGateOutcome(
  event: { toolName: string; input: unknown },
  outcome: GateOutcome,
  record: (entry: HistoryEntry) => HistoryResult,
  warn: (message: string) => void,
): void {
  if (outcome.kind !== "decided" || !outcome.log) return;
  let result: HistoryResult;
  try {
    result = record({
      tool: event.toolName,
      command: historyCommandOf(event.toolName, event.input),
      decision: outcome.decision ? "blocked" : "approved",
      by: outcome.by,
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    });
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!result.ok) warn(`Could not record auto-approval history: ${result.error}`);
}
function safeWarn(ctx: GateContext, message: string): void {
  try {
    ctx.ui.notify(message, "warning");
  } catch {}
}

export async function handleToolCall(
  event: { toolName: string; input: unknown; toolCallId?: string },
  ctx: GateContext,
  load: ConfigLoader,
  deps: GateDeps = {},
  choices: SessionChoices = {},
): Promise<GateDecision> {
  const snapshot = snapshotGate(ctx, choices, choices.enabled === false ? undefined : load);
  const outcome = await gateToolCall(event, ctx, snapshot, deps, choices, new Set());
  if (deps.history) recordGateOutcome(event, outcome, deps.history, (message) => safeWarn(ctx, message));
  return outcome.kind === "decided" ? outcome.decision : undefined;
}

type GateSnapshot = ReturnType<typeof snapshotGate>;

function protectedFileReason(
  event: { toolName: string; input: unknown },
  cwd: string,
  globalDir: string,
): string | undefined {
  if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
  const input = event.input as { path?: unknown } | null | undefined;
  if (typeof input?.path !== "string") return undefined;
  let path = input.path;
  try {
    path = resolveToolPath(path, cwd);
    const target = foldPath(resolvePathForPolicy(path));
    const sharedConfig = projectConfigPath(cwd);
    const projectDir = dirname(sharedConfig);
    const roots = [globalDir, projectDir];
    if (!roots.some((root) => isPathInsideOrEqual(target, foldPath(resolvePathForPolicy(root))))) {
      const files = [join(globalDir, CONFIG_FILENAME), sharedConfig, join(projectDir, "auto-permissions.local.json")];
      // A dangling link still names the config that would be loaded after a write.
      if (
        !files.some(
          (file) => lstatSync(file, { throwIfNoEntry: false }) && target === foldPath(resolvePathForPolicy(file)),
        )
      )
        return undefined;
    }
  } catch {
    // If a path cannot be resolved, ask rather than assume the write is safe.
  }
  return `Changes auto-approval protected file ${path}`;
}

function protectedBashReason(command: string): string | undefined {
  const text = command.toLowerCase();
  if (text.includes("pi-auto-approval") || text.includes("auto-permissions"))
    return `Changes auto-approval protected file ${command}`;
}

const SENSITIVE_FILES = [
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".bashrc",
  ".bash_profile",
  ".profile",
  ".config/fish/config.fish",
  ".ssh/authorized_keys",
];

function sensitiveReason(input: string, cwd: string): string | undefined {
  const path = resolveToolPath(input, cwd);
  try {
    const target = foldPath(resolvePathForPolicy(path));
    const sensitive = SENSITIVE_FILES.some((file) => target === foldPath(resolvePathForPolicy(join(homedir(), file))));
    return sensitive ? `Changes sensitive file ${path}` : undefined;
  } catch {
    // If a path cannot be resolved, ask rather than assume the write is safe.
    return `Changes sensitive file ${path}`;
  }
}

function sensitiveTargetReason(target: string, cwd: string): string | undefined {
  // A leading ~ or $HOME means the home directory; over-matching is safe.
  return sensitiveReason(
    target.replace(/^(?:~(?=\/|$)|\$HOME|\$\{HOME\})/, () => homedir()),
    cwd,
  );
}

function sensitiveFileReason(event: { toolName: string; input: unknown }, cwd: string): string | undefined {
  if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
  const input = event.input as { path?: unknown } | null | undefined;
  if (typeof input?.path !== "string") return undefined;
  return sensitiveReason(input.path, cwd);
}

async function gateToolCall(
  event: { toolName: string; input: unknown },
  ctx: GateContext,
  snapshot: GateSnapshot,
  deps: GateDeps,
  choices: SessionChoices,
  noticedFiles: Set<string>,
): Promise<GateOutcome> {
  const verdict = await decideToolCall(event, ctx, snapshot, deps, choices, noticedFiles);
  return !snapshot.settings.enabled && verdict.decision === undefined
    ? NOT_GATED
    : { kind: "decided", ...verdict, log: snapshot.settings.enabled };
}

async function decideToolCall(
  event: { toolName: string; input: unknown },
  ctx: GateContext,
  { config, globalDir, projectTrusted, settings }: GateSnapshot,
  deps: GateDeps,
  choices: SessionChoices,
  noticedFiles: Set<string>,
): Promise<Verdict> {
  if (isAborted(ctx)) return cancelled(CONFIRMATION_FAILED);
  const bash = event.toolName === "bash";
  const command = bashCommandOf(event.input);
  if (bash && command === undefined) return stop("config", "error", "auto-approval: invalid bash input");
  if (choices.enabled === false) return passed("config");
  if (!config) return stop("config", "config", "auto-approval: config load failed");
  if (!config.ok)
    return stop("config", "config", `auto-approval: invalid config - ${config.error}. Fix it to run tools.`);
  if (!projectTrusted) {
    const ignoredFiles = new Set<string>();
    for (const file of [config.project?.shared, config.project?.local]) {
      if (file && (file.settings.enabled !== undefined || file.settings.reviewMode !== undefined))
        ignoredFiles.add(file.source);
    }
    for (const rule of config.rules) {
      if (rule.scope === "project" && rule.level === "allow") ignoredFiles.add(rule.source);
    }
    for (const file of ignoredFiles) {
      if (noticedFiles.has(file)) continue;
      noticedFiles.add(file);
      safeNotify(ctx, `Ignored project settings from ${file} because the project is untrusted.`);
    }
  }
  if (isAborted(ctx)) return cancelled(CONFIRMATION_FAILED);
  if (!settings.enabled) return passed("config");
  // Built-in hard deny runs first: no rule, verdict or dialog overrides it.
  const inspected = bash && command !== undefined ? inspectShell(command, homedir()) : undefined;
  if (inspected?.hardDeny) return stop("hard-deny", "hardDeny", inspected.hardDeny);
  const sensitiveReasonOf = (targets: readonly { path: string }[]) =>
    targets.map((target) => sensitiveTargetReason(target.path, ctx.cwd)).find(Boolean);
  const mode = settings.reviewMode;
  const overBashApprovalLimit = bash && command !== undefined && Buffer.byteLength(command) > MAX_BASH_APPROVAL_BYTES;
  const analysis = bash && command !== undefined ? analyzeShell(command) : undefined;
  const scanMatcher = deps.matcher ?? matchPermission;
  const exactMatcher = deps.matcher ?? matchPermissionExact;
  const wholeMatcher = analysis?.supported ? exactMatcher : scanMatcher;
  const components = analysis?.supported ? analysis.components : [];
  const componentCall = (command: string) => ({ toolName: "bash", input: { command } });

  // Built-in hard deny belongs here, before any configured rule.
  const denyRules = config.rules.filter((rule) => rule.level === "deny");
  let denied: PermissionRule | undefined;
  try {
    if (denyRules.length) {
      denied = wholeMatcher(event, ctx.cwd, denyRules, projectTrusted);
      for (const component of components) {
        if (denied) break;
        denied = exactMatcher(componentCall(component.command), ctx.cwd, denyRules, projectTrusted, component.words);
      }
    }
  } catch {
    return stop("config", "error", "auto-approval: matcher error");
  }

  let protectedReason: string | undefined;
  let componentReasons: (string | undefined)[] = [];
  let componentRules: (PermissionRule | undefined)[] = [];
  let rule = denied;
  if (!denied) {
    protectedReason =
      bash && command !== undefined && !analysis?.supported
        ? (protectedBashReason(command) ?? sensitiveReasonOf(inspected?.sensitiveTargets ?? []))
        : (protectedFileReason(event, ctx.cwd, globalDir) ?? sensitiveFileReason(event, ctx.cwd));
    componentReasons = components.map(
      (component, index) =>
        protectedBashReason(component.command) ??
        sensitiveReasonOf(inspected?.sensitiveTargets.filter((target) => target.component === index) ?? []),
    );
    if (!protectedReason) {
      const remainingRules = config.rules.filter(
        (rule) => rule.level === "ask" || (rule.level === "allow" && !overBashApprovalLimit),
      );
      try {
        const wholeRules = analysis?.supported ? remainingRules.filter((rule) => rule.level === "ask") : remainingRules;
        rule = wholeMatcher(event, ctx.cwd, wholeRules, projectTrusted);
        componentRules = components.map((component, index) =>
          componentReasons[index]
            ? undefined
            : exactMatcher(componentCall(component.command), ctx.cwd, remainingRules, projectTrusted, component.words),
        );
        if (!rule && components.length === 1 && componentRules[0]?.level === "allow") rule = componentRules[0];
      } catch {
        return stop("config", "error", "auto-approval: matcher error");
      }
    }
  }
  if (isAborted(ctx)) return cancelled(CONFIRMATION_FAILED);
  const label = rule?.label ?? (bash ? "Unmatched Bash command" : `Unmatched ${event.toolName} call`);
  const reviewerConfig =
    choices.reviewerModel === undefined
      ? config.reviewer
      : { ...config.reviewer, model: choices.reviewerModel ?? undefined };
  const reviewer = reviewerConfig.model ? `${reviewerConfig.model.provider}/${reviewerConfig.model.id}` : deps.reviewer;
  const policy = resolveReviewerPolicy(
    { ...config, global: config.global ?? config, project: config.project ?? {} },
    projectTrusted,
  );
  const review = async (
    request: Pick<ReviewInput, "command" | "component" | "tool" | "arguments">,
  ): Promise<ReviewResult> => {
    try {
      if (deps.review)
        return await deps.review({
          ...request,
          reviewer: reviewerConfig,
          reviewEvidence: config.reviewEvidence,
          policy,
          projectTrusted,
          signal: ctx.signal,
        });
    } catch {}
    return { ok: false, error: "reviewer unavailable" } as const;
  };
  const report = (state: ReviewState, detail?: string) => {
    if (!ctx.hasUI || !settings.debug || !config.ui.status || !deps.status || isAborted(ctx)) return;
    try {
      deps.status({
        state,
        label,
        ...(rule?.source ? { source: rule.source } : {}),
        ...(state === "guardian-running" && reviewer ? { reviewer } : {}),
        ...(detail ? { detail } : {}),
        ui: config.ui,
      });
    } catch {}
  };
  const attribution = rule ? `(${rule.label}, ${rule.source})` : "";
  const confirm = async (reason: string, headlessSource: BlockSource = "noUI"): Promise<Verdict> => {
    if (!ctx.hasUI)
      return stop(headlessSource === "protectedPath" ? "protected-path" : "headless", headlessSource, reason);
    if (isAborted(ctx)) return cancelled(CONFIRMATION_FAILED);
    report("approval-required");
    if (isAborted(ctx)) return cancelled(CONFIRMATION_FAILED);
    try {
      const approved = await ctx.ui.confirm(
        `Approve command?${rule ? ` [${rule.label}]` : ""}`,
        `${reason}\n\n${bash ? command : callExcerpt(event.toolName, event.input)}`,
        { signal: ctx.signal },
      );
      if (isAborted(ctx) || approved !== true) {
        report("blocked", isAborted(ctx) ? "Cancelled" : undefined);
        return isAborted(ctx)
          ? cancelled(`${reason} (review cancelled)`)
          : stop("user", "user", `${reason} (user declined)`);
      }
      report("approved");
      return isAborted(ctx) ? cancelled(CONFIRMATION_FAILED) : passed("user");
    } catch {
      report("blocked");
      return stop("cancelled", "error", `${reason} (confirmation failed)`);
    }
  };
  if (rule?.level === "deny") {
    report("blocked");
    return stop("deny-rule", "denyRule", `${rule.label}, ${rule.source}`);
  }
  if (protectedReason) return confirm(protectedReason, "protectedPath");
  if (analysis && !analysis.supported && !analysis.reviewable)
    return confirm(`${analysis.reason} requires confirmation`);
  if (bash && analysis?.supported) {
    const reasons: string[] = rule?.level === "ask" ? [`Requires confirmation ${attribution}`] : [];
    const used = new Set<HistoryBy>();
    const reviewerReasons: string[] = [];
    for (let index = 0; index < analysis.components.length; index++) {
      if (isAborted(ctx)) return cancelled(CONFIRMATION_FAILED);
      const component = analysis.components[index]!;
      const reason = componentReasons[index];
      if (reason) {
        reasons.push(reason);
        continue;
      }
      const componentRule = componentRules[index];
      if (componentRule?.level === "allow") {
        if (settings.debug) safeNotify(ctx, `Allowed by rule (${componentRule.label}, ${componentRule.source})`);
        used.add("allow-rule");
        continue;
      }
      if (componentRule?.level === "ask") {
        reasons.push(`Requires confirmation (${componentRule.label}, ${componentRule.source})`);
        continue;
      }
      if (!overBashApprovalLimit && isReadOnlyComponent(component.command)) {
        if (settings.debug) safeNotify(ctx, "Allowed as read-only command");
        used.add("read-only");
        continue;
      }
      if (mode === "manual") {
        reasons.push(`${label} requires confirmation`);
        continue;
      }
      report("guardian-running");
      if (isAborted(ctx)) return cancelled(CONFIRMATION_FAILED);
      const result = await review({
        command: component.command,
        component: {
          originalCommand: command!,
          index: index + 1,
          count: analysis.components.length,
          start: component.start,
          end: component.end,
          context: component.context,
        },
      });
      if (isAborted(ctx)) {
        report("blocked", "Cancelled");
        return cancelled(CONFIRMATION_FAILED);
      }
      if (!result.ok) {
        if (result.cancelled) {
          report("blocked", "Cancelled");
          return cancelled("Review cancelled");
        }
        reasons.push(`Automatic review failed: ${result.error}`);
        continue;
      }
      const { verdict } = result;
      const { decision, tier, reason: reviewReason } = verdict;
      switch (decision) {
        case "approve":
          switch (tier) {
            case "allow":
            case "user_intent":
            case "none":
              used.add("reviewer");
              reviewerReasons.push(reviewReason);
              continue;
            default:
              return invalidVerdict(tier);
          }
        case "block":
          switch (tier) {
            case "hard_deny":
              report("blocked");
              return stop("reviewer", "reviewer", reviewReason);
            case "soft_deny":
              reasons.push(`Reviewer needs user approval: ${reviewReason}`);
              break;
            default:
              return invalidVerdict(tier);
          }
          break;
        case "revise":
          if (tier !== "none") return invalidVerdict(tier);
          report("revision-requested");
          reasons.push(
            `Reviewer requested a revision: ${reviewReason}\nConstraint: ${verdict.constraint}\nSource: ${verdict.source}\nApprove the original action once?`,
          );
          break;
        default:
          return invalidVerdict(decision);
      }
    }
    if (isAborted(ctx)) return cancelled(CONFIRMATION_FAILED);
    if (reasons.length)
      return confirm([...new Set(reasons)].join("\n"), componentReasons.some(Boolean) ? "protectedPath" : "noUI");
    report("approved");
    if (isAborted(ctx)) return cancelled(CONFIRMATION_FAILED);
    if (used.has("reviewer")) return passed("reviewer", [...new Set(reviewerReasons)].join("\n"));
    return passed(used.has("allow-rule") ? "allow-rule" : "read-only");
  }
  if (rule?.level === "ask") return confirm(`Requires confirmation ${attribution}`);
  if (rule?.level === "allow" && !bash) {
    if (settings.debug) safeNotify(ctx, `Allowed by rule (${rule.label}, ${rule.source})`);
    report("approved");
    return isAborted(ctx) ? cancelled(CONFIRMATION_FAILED) : passed("allow-rule");
  }
  if (mode === "manual") return confirm(`${label} requires confirmation`);
  if (isAborted(ctx)) return cancelled(CONFIRMATION_FAILED);
  report("guardian-running");
  if (isAborted(ctx)) return cancelled(CONFIRMATION_FAILED);
  const result = await review(bash ? { command: command ?? "" } : { tool: event.toolName, arguments: event.input });
  if (isAborted(ctx)) {
    report("blocked", "Cancelled");
    return cancelled(CONFIRMATION_FAILED);
  }
  if (!result.ok) {
    if (result.cancelled) {
      report("blocked", "Cancelled");
      return cancelled("Review cancelled");
    }
    return confirm(`Automatic review failed: ${result.error}`);
  }
  const { verdict } = result;
  const { decision, tier, reason } = verdict;
  switch (decision) {
    case "approve":
      switch (tier) {
        case "allow":
        case "user_intent":
        case "none":
          report("approved");
          return isAborted(ctx) ? cancelled(CONFIRMATION_FAILED) : passed("reviewer", reason);
        default:
          return invalidVerdict(tier);
      }
    case "block":
      switch (tier) {
        case "hard_deny":
          report("blocked");
          return stop("reviewer", "reviewer", reason);
        case "soft_deny":
          return confirm(`Reviewer needs user approval: ${reason}`);
        default:
          return invalidVerdict(tier);
      }
    case "revise":
      if (tier !== "none") return invalidVerdict(tier);
      report("revision-requested");
      return confirm(
        `Reviewer requested a revision: ${reason}\nConstraint: ${verdict.constraint}\nSource: ${verdict.source}\nApprove the original action once?`,
      );
    default:
      return invalidVerdict(decision);
  }
}

export default function autoApproval(pi: ExtensionAPI, verifiedVersions?: readonly string[]): void {
  const reviewerState = createReviewerState();
  const controllers = new Set<AbortController>();
  const cancelPending = () => {
    for (const controller of controllers) controller.abort();
  };
  const globalDir = globalConfigDir();
  const display = createReviewDisplay(pi, VERSION, verifiedVersions);
  const permissions = createPermissionsController(globalDir, cancelPending, (ctx) => display.reset(ctx));
  let approvalDialogOpened = false;
  let historyWarned = false;
  const noticedFiles = new Set<string>();
  let callId = 0;
  pi.registerCommand("permissions", {
    description: "Configure tool protection and review mode",
    handler: (args, ctx) => permissions.menu(args, ctx),
  });
  pi.on("tool_call", async (event, ctx) => {
    const controller = new AbortController();
    controllers.add(controller);
    const signal = AbortSignal.any([controller.signal, ...(ctx.signal ? [ctx.signal] : [])]);
    const widgetKey = `auto-approval:${++callId}`;
    const callToolId = event.toolCallId ?? widgetKey;
    const displayGeneration = display.generation();
    const adapted: GateContext = {
      cwd: ctx.cwd,
      hasUI: ctx.hasUI,
      signal,
      isProjectTrusted: () => ctx.isProjectTrusted(),
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
        notify: (message, type) => ctx.ui.notify(message, type),
      },
    };
    const choices = permissions.snapshot();
    const snapshot = snapshotGate(adapted, choices, (cwd) => loadConfig(cwd, globalDir), globalDir);
    permissions.refreshFooter(ctx, snapshot);
    const finalize = (outcome: GateOutcome): void => {
      recordGateOutcome(
        event,
        outcome,
        (entry) => recordHistory(ctx.cwd, entry),
        (message) => {
          if (historyWarned) return;
          historyWarned = true;
          safeWarn(adapted, message);
        },
      );
    };
    let lastReport: GateReport | undefined;
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<GateOutcome>((resolve) => {
      abortListener = () => {
        if (lastReport)
          display.show(
            ctx,
            lastReport.ui,
            { ...lastReport, state: "blocked", detail: "Cancelled", toolCallId: callToolId },
            widgetKey,
            displayGeneration,
          );
        resolve({
          kind: "decided",
          ...cancelled(CONFIRMATION_FAILED),
          log: snapshot.settings.enabled,
        });
      };
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) abortListener();
    });
    const pending = gateToolCall(
      event,
      adapted,
      snapshot,
      {
        reviewer: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        review: createPiReviewer(
          {
            cwd: ctx.cwd,
            get model() {
              return ctx.model;
            },
            modelRegistry: ctx.modelRegistry,
            sessionManager: ctx.sessionManager,
          },
          reviewerState,
        ),
        status: (report) => {
          lastReport = report;
          display.show(ctx, report.ui, { ...report, toolCallId: callToolId }, widgetKey, displayGeneration);
        },
      },
      choices,
      noticedFiles,
    );
    try {
      const outcome = await Promise.race([pending, aborted]);
      finalize(outcome);
      return outcome.kind === "decided" ? outcome.decision : undefined;
    } finally {
      if (abortListener) signal.removeEventListener("abort", abortListener);
      controllers.delete(controller);
      void pending.catch(() => {});
    }
  });
  pi.on("tool_execution_end", (event) => {
    if (event.toolName === "bash") display.dropInvalidator(event.toolCallId);
  });
  pi.on("session_start", (_event, ctx) => {
    cancelPending();
    noticedFiles.clear();
    const seeded = ensureGlobalConfig(globalDir);
    if ("error" in seeded)
      ctx.ui.notify(`Could not create default config ${join(globalDir, CONFIG_FILENAME)}: ${seeded.error}`, "warning");
    permissions.reset(ctx);
    permissions.refreshFooter(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    permissions.close();
    cancelPending();
    display.shutdown(ctx);
  });
}
