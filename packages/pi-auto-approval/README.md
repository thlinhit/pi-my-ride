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

Use `/permissions` for the interactive menu: protection on/off, auto/manual review, save settings, or clear session choices and reload. Choices apply immediately but remain session-local until saved. All session starts (`startup`, `reload`, `new`, `resume`, `fork`) clear choices. Save writes only the global file, preserves unrelated fields, and refuses invalid or concurrently changed targets rather than overwriting them. External file edits take effect on the next Bash call. A protection or review-mode change cancels and blocks pending attempts. Explicit session-level protection off bypasses config validation and this extension's gating; turning it back on restores validation.

## Reviewer and limits

Reviewer settings are optional: `provider` and `model` must be supplied together (otherwise the active model is used), `reasoningEffort` defaults to `low`, and `timeoutMs` defaults to `30000` (valid range 1000–300000). Supply either non-blank `extraInstructions` or `extraInstructionsFile`, not both; file paths are relative to the global config.

Reviewer sessions are reused with stable `sessionId` and `cacheRetention: "long"`; reviews are serialized. Reuse resets when model/session/instructions/evidence change, evidence is no longer an unchanged prefix, prompt usage reaches budget, or a review fails or is cancelled. The reviewer caps estimated prompt size at 80% of context window (128,000 tokens by default) and does not truncate history; overflow falls back to confirmation, and blocks without UI. Evidence lineage and cache data are advisory, not authoritative; compaction summaries can omit constraints. Project instructions are opt-in via `reviewEvidence.projectInstructions: true`, include only trusted-project `AGENTS.md` (otherwise `CLAUDE.md`) in the system prompt, and never authorize commands. Broader review coverage can increase model cost.

Only the Bash tool is gated. Other tools, user `!`/`!!` commands, and extension `pi.exec` are outside scope (nested `ctx.executeTool("bash", ...)` is gated). Config and project files can be written by the agent through other tools. This is **not a sandbox and not a security boundary**; regular expressions and review are advisory, not command isolation. No manual real-Pi or real-model check has been performed for this phase.

## Automated coverage

Run `npm test && npm run typecheck` from the repository root. Tests cover strict global/project and nested validation; rule priority, trust, attribution and suspicious raw text; manual/auto/off routes; all five session resets; pending human/model cancellation, late approvals and dialog-lock retention; external-edit selection snapshots; and save conflicts from modification, deletion or appearance. Phase 4 reviewer evidence, budget, cache and lineage tests remain, including five-step comparisons against fresh reviews. Providers and UI are mocked; these tests do not establish real-model approval quality or live Pi behavior.

## Harmless-command checklist

For a manual Pi check: run `/permissions`; turn protection off and run `echo off-ok`; turn on + manual and run `echo manual` (expect confirmation); select auto and run `echo auto` (expect review); verify untrusted project allows are reported/ignored and suspicious allow text such as `echo "a; b"` prompts; save and inspect `~/.pi/agent/auto-permissions.json`; verify malformed config blocks, then session off bypasses it; start `/new` and confirm session choices clear. Automated tests cover save interleavings; do not treat manual editing before Save as a conflict because Save reads the current value first.
