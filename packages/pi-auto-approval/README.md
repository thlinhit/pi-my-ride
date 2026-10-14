# pi-auto-approval

A Pi extension that applies regex-based approval rules to Bash tool calls.

## Install

```bash
pi install npm:@thlinhit/pi-auto-approval
```

## Local testing

```bash
pi --extension ./packages/pi-auto-approval/src/index.ts
```

## Configuration

Global settings live in `~/.pi/agent/auto-permissions.json`. Optional project rules live in `.pi/auto-permissions.json`. Defaults are protection on, manual review, and no rules. Global settings control protection and review mode; project config may contain only `rules`. Both files are validated and their rules are combined (global first, then project).

```json
{
  "enabled": true,
  "reviewMode": "manual",
  "rules": []
}
```

Rule examples below are illustrative only; they are not shipped or seeded. Rules require `pattern`, `label`, and `level` (`deny`, `ask`, or `allow`). Optional `flags` and `message` are supported. Unsupported fields and obsolete values are errors.

```json
{
  "rules": [
    { "pattern": "^git push\\b", "level": "deny", "label": "block pushes" },
    { "pattern": "^terraform apply\\b", "level": "ask", "label": "confirm apply" },
    { "pattern": "^git status$", "level": "allow", "label": "status" }
  ]
}
```

The shipped [`examples/auto-permissions.json`](examples/auto-permissions.json) contains an empty rules list. Matching actions use `deny > ask > allow`, regardless of file or list order. At a winning priority, the first global match is shown, otherwise the first project match. Project `allow` rules are ignored in untrusted projects and reported; project `deny` and `ask` rules still apply. A project rule never replaces global rules.

## Review and controls

A deny blocks without review. An ask always requires human confirmation. An allow avoids review only for a command without apparent combination or nesting. The conservative raw-text check flags `;`, newline, carriage return, `&`, `|`, `$(`, backticks, `<(`, and `>(` anywhere, including quoted text. This intentionally permits false positives, such as `echo "hello; world"` and `cmd 2>&1`. It is not exhaustive, is not a shell parser, and does not establish command safety.

Unmatched commands require human confirmation in manual mode (the default) or model review in auto mode. Reviewer approval permits; revision blocks; ask-user requires confirmation. Reviewer errors and timeouts fall back to confirmation. Any confirmation route blocks when no UI is available. Manual mode never calls the reviewer.

Use `/permissions` for the interactive menu: protection on/off, auto/manual review, reviewer model, save settings, or clear session choices and reload. Protection and review-mode choices apply immediately but remain session-local until saved. Reviewer model choices are not session-local: they save to the global file immediately. All session starts (`startup`, `reload`, `new`, `resume`, `fork`) clear unsaved protection and review-mode choices; they do not clear a saved reviewer selection. Save writes only the global file, preserves unrelated fields, and refuses invalid or concurrently changed targets rather than overwriting them. External file edits take effect on the next Bash call. A protection or review-mode change cancels and blocks pending attempts. Explicit session-level protection off bypasses config validation and this extension's gating; turning it back on restores validation.

The protection footer shows `🛡️ guardian: off`, `🛡️ guardian: auto`, or `🛡️ guardian: manual`. Setting `ui.status: false` hides valid-config status. Invalid configuration still shows `⚠ protection config error · Bash blocked`, unless protection is explicitly disabled for the session, which shows `🛡️ guardian: off`.

## Reviewer and limits

Reviewer settings are optional: `provider` and `model` must be supplied together (otherwise the active model is used), `reasoningEffort` defaults to `low`, and `timeoutMs` defaults to `30000` (valid range 1000–300000). Supply either non-blank `extraInstructions` or `extraInstructionsFile`, not both; file paths are relative to the global config.

Reviewer model selection is the **Reviewer model** item in `/permissions`. It lists available chat-model entries from Pi's registry (`getAvailable`), in registry order, excluding providers without configured authentication. Each label is numbered (`1. provider/id`) because provider/id labels can collide, so every entry is reachable. Availability follows Pi's configured-provider snapshot; it does not guarantee reachability or a successful review. Classifier and image models are separate operation types and are not reviewer inputs. Choosing an entry saves that provider/model pair to the global `auto-permissions.json` immediately. The save stages the file beside the target and renames it into place, so a failed write keeps the previous bytes and selection, and the failure notice reports the path, the error, and that the previous selection is retained. This is not a cross-process lock or a crash-durability guarantee. **Use active model** removes the pair, so each later review uses the live conversation model, including model changes made after the selection. Selection changes affect future attempts only. Selecting a reviewer does not cancel an active review, a queued attempt that already captured its settings, or a pending confirmation. If the selected reviewer is unusable (for example, not found in the registry, or without configured auth), the review error is shown and the human is asked to confirm; without UI the attempt is blocked. The reviewer never substitutes the active model or another model. There is no automatic reviewer selection.

Reviewer sessions are reused with stable `sessionId` and `cacheRetention: "long"`; reviews are serialized. Reuse resets when model/session/instructions/evidence change, evidence is no longer an unchanged prefix, prompt usage reaches budget, or a review fails or is cancelled. The reviewer caps estimated prompt size at 80% of context window (128,000 tokens by default) and does not truncate history; overflow falls back to confirmation, and blocks without UI. Evidence lineage and cache data are advisory, not authoritative; compaction summaries can omit constraints. Project instructions are opt-in via `reviewEvidence.projectInstructions: true`, include only trusted-project `AGENTS.md` (otherwise `CLAUDE.md`) in the system prompt, and never authorize commands. Broader review coverage can increase model cost.

Only the Bash tool is gated. Other tools, user `!`/`!!` commands, and extension `pi.exec` are outside scope (nested `ctx.executeTool("bash", ...)` is gated). Config and project files can be written by the agent through other tools. This is **not a sandbox and not a security boundary**; regular expressions and review are advisory, not command isolation. No manual real-Pi or real-model check has been performed for this phase.

## Automated coverage

Run `npm test && npm run typecheck` from the repository root. Tests cover strict global/project and nested validation; rule priority, trust, attribution and suspicious raw text; manual/auto/off routes; all five session resets; pending human/model cancellation, late approvals and dialog-lock retention; external-edit selection snapshots; and save conflicts from modification, deletion or appearance. Phase 4 reviewer evidence, budget, cache and lineage tests remain, including five-step comparisons against fresh reviews. Reviewer-selection tests cover the atomic global save (partial-write, rename, and external-change failures), the `/permissions` picker, and routing through the real extension loader and Pi's real model registry and auth path: the real `getAvailable` listing (excluding unconfigured providers), `find` resolution, an unregistered selected model, and a selected provider losing configured auth, which reports Pi's own not-configured error. UI replies and successful provider replies are controlled doubles. These tests do not establish live TUI usability, real-model approval quality, or live Pi behavior.

## Phase 5 tool-row status

Tool-row status is an opt-in renderer adaptation. It calls Pi's public `registerToolRenderer` resolver and `next()` to wrap only the native Bash `renderCall`; Bash execution and native `renderResult` remain unchanged. The extension checks the installed Pi version and current builtin Bash identity before using a row, and otherwise falls back to the editor widget.

Automated native-renderer evidence is recorded in [`docs/phase-5/verification.md`](../../docs/phase-5/verification.md). It uses the public `createBashToolDefinition`, `ToolExecutionComponent`, and renderer APIs. Tool-row status is admitted only for exact tested Pi version `1.2.0` (`VERIFIED_PI_VERSIONS` in `src/ui/rows.ts`). The renderer-only contract checks builtin Bash attribution (source and path) and row readiness; it does not claim a backend definition identity. Any failed check, unverified version, or non-builtin Bash falls back to the widget path.

No real Pi session or provider check has been performed for this phase.

## Harmless-command checklist

For a manual Pi check: run `/permissions`; turn protection off and run `echo off-ok`; turn on + manual and run `echo manual` (expect confirmation); select auto and run `echo auto` (expect review); verify untrusted project allows are reported/ignored and suspicious allow text such as `echo "a; b"` prompts; save and inspect `~/.pi/agent/auto-permissions.json`; verify malformed config blocks, then session off bypasses it; start `/new` and confirm session choices clear. Automated tests cover save interleavings; do not treat manual editing before Save as a conflict because Save reads the current value first.
