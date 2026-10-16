# pi-auto-approval

A Pi extension that gates every tool call. Permission rules decide whether a call is denied, needs confirmation, or runs. Calls that no rule matches go to an AI reviewer or to you, depending on the review mode.

## Install

```bash
pi install npm:@thlinhit/pi-auto-approval
```

## Local testing

```bash
pi --extension ./packages/pi-auto-approval/src/index.ts
```

## Configuration

Two files hold permission rules. Both use the `permissions` shape. The global file also holds protection, review, reviewer, and UI settings.

| Scope | Path | Holds |
|---|---|---|
| Global | `~/.pi/pi-auto-approval/auto-permissions.json` | `enabled`, `reviewMode`, `permissions`, `reviewer`, `reviewEvidence`, `ui` |
| Project | `<cwd>/.pi/pi-auto-approval/auto-permissions.json` | `permissions` (`allow`, `ask`, `deny`) only |
| History | `<cwd>/.pi/pi-auto-approval/history.jsonl` | Tool call log, see [History](#history) |

`<cwd>` is the session's working directory. Files at the older locations (`~/.pi/agent/auto-permissions.json` and `.pi/auto-permissions.json`) are not read. There is no migration.

```json
{
  "enabled": true,
  "reviewMode": "auto",
  "permissions": {
    "allow": ["Bash(git status)"],
    "ask": ["Bash(git push *)"],
    "deny": ["Read(./.env)"],
    "defaultMode": "manual"
  }
}
```

### Starter seed

On the first `session_start` with no global file, the extension creates it with the starter seed below using exclusive creation (`wx`). An existing file is never overwritten or migrated, even if invalid. Installing the package and loading the extension factory do not seed config. Session startup seeds only the global file, never a project file.

A missing global file uses the seed in memory without writing it. If startup cannot create the file, it warns; a genuinely missing file still uses the seed, while an unreadable or invalid config blocks protected calls.

- `allow`: `Bash(git status)`, `Bash(git diff)`, `Bash(git diff --stat)`, `Bash(git log -5 --oneline)`
- `ask`: `Bash(git push *)`, `Bash(git reset *)`, `Bash(git clean *)`, `Bash(rm *)`
- `deny`: `Bash(security)`, `Bash(security *)`, `Read(./.env)`, `Read(./.env.*)`, `Read(./secrets/**)`, `Edit(./.env)`, `Edit(./.env.*)`, `Edit(./secrets/**)`
- `defaultMode`: `"manual"`

The shipped [`examples/auto-permissions.json`](examples/auto-permissions.json) has the same content. It includes the global-only `defaultMode` field; omit that field if adapting the example for a project. No example or seed is copied into projects automatically.

### Rule grammar

A rule is a tool name, optionally followed by a specifier in parentheses: `Tool` or `Tool(specifier)`.

- Built-in tool names are case-insensitive: `bash`, `read`, `edit`, `write`, `grep`, `find`, `ls`, `powershell`.
- Other tool names match exactly. They take no wildcard and no specifier.
- Only `Bash`, `Read`, `Edit`, and `Write` take a specifier. Any other specifier is a config error.
- The specifier runs from the first `(` to the final `)`. Parentheses inside it are literal.
- Leading and trailing whitespace around a rule is ignored. A blank rule or blank specifier is a config error.

**Bash** patterns match the whole raw command. `*` is the only wildcard, and it matches any text, including spaces. Everything else is literal. `Bash(git push *)` matches `git push origin main` and does not match `git status`.

For `deny` and `ask`, the command is also split into shell segments at `;`, `&`, `|`, newline, carriage return, backtick, `(`, `)`, `<`, and `>`. Each non-empty segment is tested too. This is conservative and can over-match. `allow` tests only the whole command, so `Bash(git status)` does not allow `git status; rm -rf dist`.

**Read, Edit, and Write** patterns are matched against the resolved path:

- Tool input paths expand `~` and `~/`, strip one leading `@`, decode `file://` URLs, and treat Unicode space characters as ASCII spaces. Relative paths resolve against the session's working directory.
- Configured patterns resolve relative to the session's working directory, not the config file's directory. `~/` and `file://` patterns are supported. Only stars written in the pattern are wildcards; characters in the working-directory and home-directory prefixes stay literal.
- `*` matches within one path segment. `**` matches across segments.
- `Edit(...)` also covers `Write`. `Read(...)` covers only `Read`.
- Absolute paths inside the project match file rules. `Read(./.env)` also matches the absolute path of `.env` under the session directory.
- `Read` mirrors Pi's native Read fallbacks. If the path as written does not exist, it also tries U+202F instead of the space before `AM.`/`PM.`, the NFD form, the curly-apostrophe form, and the NFD plus curly-apostrophe form. `Edit` and `Write` do not use these fallbacks.

Matching is lexical after this normalization. Symlinks and case-insensitive filesystems are not resolved.

### Precedence and trust

- Across all rules, `deny` beats `ask`, and `ask` beats `allow`, regardless of file order.
- Within one level, global rules are checked before project rules; within each scope, the first matching entry supplies the displayed rule and source.
- In an untrusted project, project `allow` rules are ignored and a notice names the file. Project `deny` and `ask` rules still apply.
- A project allow cannot weaken a global deny or ask. A project deny can still block a global allow, and a project ask can require confirmation for one.

### `defaultMode` and `reviewMode`

- `permissions.defaultMode` accepts only `"manual"`. Any other value is a config error. It does not change routing. Unmatched calls use `reviewMode`, which defaults to `"auto"`.
- `reviewMode` (global only) is `"auto"` or `"manual"`. Auto sends unmatched calls to the AI reviewer. Manual asks you for every unmatched call and never calls the reviewer. An explicit `"manual"` is a human-only override.

### Config errors

A missing global file uses the starter seed; a missing project file adds no rules. Invalid JSON, invalid schema, and read failures other than a missing file are config errors. A config error blocks every protected tool call, not just Bash:

```text
auto-approval: invalid config - <error>. Fix it to run tools.
```

Errors include unknown keys, an object where a string is expected, a bad rule, `permissions.defaultMode` other than `"manual"`, and the legacy `rules` key:

```text
<path>: unsupported field "rules"
```

Old rule objects with `pattern`, `label`, `level`, `flags`, or `message` are not accepted. Rewrite them as `permissions` strings by hand.

## Review and controls

Each tool call is checked in this order:

1. **Session protection off**: bypasses config validation and gating.
2. **Config error**: blocked, see above. Otherwise, global `enabled: false` bypasses gating unless the session explicitly turns protection on.
3. **Deny match**: blocked. No review.
4. **Ask match**: confirmation required. No review.
5. **Allow match**: runs without review. For Bash, a command with suspicious raw text requires confirmation instead. Suspicious text is `;`, `&`, `|`, newline, carriage return, backtick, `$(`, `<(`, or `>(` anywhere in the command, including inside quotes. This check is intentionally over-cautious. `echo "a; b"` and `cmd 2>&1` both trigger it. It is not a shell parser and does not establish that a command is safe.
6. **No match**: `reviewMode` decides.
   - `manual`: confirmation required. No reviewer call.
   - `auto`: the reviewer decides. Approve runs the call. Revise blocks it and returns the requested revision. Ask-user requires confirmation. Reviewer errors and timeouts fall back to confirmation.

Already-cancelled calls and malformed Bash input fail closed before the protection-off checks. Any confirmation blocks when no UI is available. Confirmations for unmatched calls read `Unmatched Bash command` or `Unmatched <tool> call`.

The reviewer sees the Bash command for Bash calls. For other tools it sees the tool name and its full arguments, which are untrusted content. Confirmation dialogs for other tools show the tool name and a truncated argument excerpt. The full arguments still go to the reviewer.

**Cost:** every tool call with no matching rule is reviewed in auto mode. Reads, searches, and listings each cost one review. Add `allow` rules for frequent safe calls, or use manual mode.

Use `/permissions` for the interactive menu: protection on/off, auto/manual review, reviewer model, save settings, or clear session choices and reload. Protection and review-mode choices apply immediately but stay session-local until saved. Reviewer model choices are not session-local: they save to the global config file immediately. All session starts (`startup`, `reload`, `new`, `resume`, `fork`) clear unsaved protection and review-mode choices; they do not clear a saved reviewer selection. Save writes only the global config file, preserves unrelated fields, and refuses invalid or concurrently changed targets rather than overwriting them. External edits to config files take effect on the next tool call. A protection or review-mode change cancels and blocks pending attempts. Explicit session-level protection off bypasses config validation and this extension's gating. Turning it back on restores validation.

The protection footer shows `🛡️ guardian: off`, `🛡️ guardian: auto`, or `🛡️ guardian: manual`. Setting `ui.status: false` hides valid-config status. Invalid configuration shows `⚠ protection config error · tools blocked`, unless protection is explicitly disabled for the session, which shows `🛡️ guardian: off`.

## History

Each gated tool call appends one JSON line to `<cwd>/.pi/pi-auto-approval/history.jsonl`. The directory is created if needed.

```json
{"time":"2026-10-16T09:30:00.000Z","tool":"bash","command":"git push origin main","decision":"blocked"}
```

- `time`: ISO 8601 timestamp in UTC, taken when the record is written.
- `tool`: the tool name, as Pi reports it.
- `command`: for `bash`, the command text after redaction. For `read`, `edit`, and `write`, the `path` argument as the tool received it, unresolved. For other tools, the string `command` input if present, otherwise `""`.
- `decision`: `"approved"` when the gate let the call proceed, through an allow rule, an approval, or a reviewer approval. `"blocked"` when the gate stopped it. This is the gate result only. It does not show whether the tool then succeeded or failed.

History holds nothing else. It has no reviewer reasons, reviewer output, transcripts, provider records, or displayed text.

**Redaction is best effort.** Before writing, `command` is redacted. Replaced values become `[REDACTED]`. The redaction covers:

- values of secret-named assignments (names containing `secret`, `token`, `password`, `passwd`, `api_key`, `api-key`, `apikey`, or `credential`)
- values of `--password`, `--token`, `--secret`, and `--api-key` options
- `Authorization` and `Bearer` header values
- AWS access key IDs (`AKIA...`), GitHub tokens (`gh[pousr]_`, `github_pat_`), `sk-` keys, and `xox` Slack tokens
- PEM private key blocks
- credential-bearing `scheme://user:pass@` URLs

Unknown secret formats are not guaranteed to be redacted. If redaction throws, that record is skipped. The raw command is never written.

**Failures never change the decision.** If the write fails, the call keeps its decision and runs or stops as the gate decided. You see one warning per extension instance:

```text
Could not record auto-approval history: <error>
```

The error is `History save failed` or `History redaction failed`.

**Protection off records nothing.** No history is written while protection is off for the session or in global config.

## Reviewer and limits

Reviewer settings are optional: `provider` and `model` must be supplied together (otherwise the active model is used), `reasoningEffort` defaults to `low`, and `timeoutMs` defaults to `30000` (valid range 1000–300000). Supply either non-blank `extraInstructions` or `extraInstructionsFile`, not both; file paths are relative to the global config.

Reviewer model selection is the **Reviewer model** item in `/permissions`. It lists available chat-model entries from Pi's registry (`getAvailable`), in registry order, excluding providers without configured authentication. Each label is numbered (`1. provider/id`) because provider/id labels can collide, so every entry is reachable. Availability follows Pi's configured-provider snapshot; it does not guarantee reachability or a successful review. Classifier and image models are separate operation types and are not reviewer inputs. Choosing an entry saves that provider/model pair to the global config file immediately. The save stages the file beside the target and renames it into place, so a failed write keeps the previous bytes and selection, and the failure notice reports the path, the error, and that the previous selection is retained. This is not a cross-process lock or a crash-durability guarantee. **Use active model** removes the pair, so each later review uses the live conversation model, including model changes made after the selection. Selection changes affect future attempts only. Selecting a reviewer does not cancel an active review, a queued attempt that already captured its settings, or a pending confirmation. If the selected reviewer is unusable (for example, not found in the registry, or without configured auth), the review error is shown and the human is asked to confirm; without UI the attempt is blocked. The reviewer never substitutes the active model or another model. There is no automatic reviewer selection.

Reviewer sessions are reused with stable `sessionId` and `cacheRetention: "long"`; reviews are serialized. Reuse resets when model/session/instructions/evidence change, evidence is no longer an unchanged prefix, prompt usage reaches budget, or a review fails or is cancelled. The reviewer caps estimated prompt size at 80% of context window (128,000 tokens by default) and does not truncate history; overflow falls back to confirmation, and blocks without UI. Evidence lineage and cache data are advisory, not authoritative; compaction summaries can omit constraints. Project instructions are opt-in via `reviewEvidence.projectInstructions: true`, include only trusted-project `AGENTS.md` (otherwise `CLAUDE.md`) in the system prompt, and never authorize commands.

**Limits.** Rules and review are guardrails, not a sandbox or a security boundary. They are advisory.

- Bash patterns match command text only. Absolute shell binaries (for example `/usr/bin/security`), wrappers, `sudo`, scripts that run other commands, and other indirect execution do not match `Bash(...)` rules. `Bash(security)` does not stop `/usr/bin/security find-generic-password`.
- PowerShell is not a Bash-pattern target. A PowerShell call is gated only by a bare `powershell` rule (an exact tool match with no specifier) or by an unmatched review.
- Absolute in-project file paths do match file rules, as described above.
- File matching is lexical. No guarantee covers symlinks, case-folding filesystems, or paths that reach denied files through other routes.
- Not gated: user `!` and `!!` commands, direct filesystem or network access inside other extensions, and `pi.exec` from extensions.
- Config files can be changed by the agent through allowed tools, or outside Pi. Config is read on every tool call.
- Redaction is best effort. History is not an audit log.

No manual real-Pi or real-model check has been performed for this phase. The statements above come from automated tests and the implementation.

## Automated coverage

Run `npm test && npm run typecheck` from the repository root. Tests cover strict global/project and nested validation; the rule grammar, precedence, trust, path normalization, attribution, and suspicious raw text; manual/auto/off routes; all five session resets; pending human/model cancellation, late approvals and dialog-lock retention; external-edit selection snapshots; and save conflicts from modification, deletion or appearance. History tests cover the exact record fields, redaction forms, and warning-only write failures. Phase 4 reviewer evidence, budget, cache and lineage tests remain, including five-step comparisons against fresh reviews. Reviewer-selection tests cover the atomic global save (partial-write, rename, and external-change failures), the `/permissions` picker, and routing through the real extension loader and Pi's real model registry and auth path: the real `getAvailable` listing (excluding unconfigured providers), `find` resolution, an unregistered selected model, and a selected provider losing configured auth, which reports Pi's own not-configured error. UI replies and successful provider replies are controlled doubles. These tests do not establish live TUI usability, real-model approval quality, or live Pi behavior.

## Phase 5 tool-row status

Tool-row status is an opt-in renderer adaptation. It calls Pi's public `registerToolRenderer` resolver and `next()` to wrap only the native Bash `renderCall`; Bash execution and native `renderResult` remain unchanged. The extension checks the installed Pi version and current builtin Bash identity before using a row, and otherwise falls back to the editor widget.

Automated native-renderer evidence is recorded in [`docs/phase-5/verification.md`](../../docs/phase-5/verification.md). It uses the public `createBashToolDefinition`, `ToolExecutionComponent`, and renderer APIs. Tool-row status is admitted only for exact tested Pi version `1.2.0` (`VERIFIED_PI_VERSIONS` in `src/ui/rows.ts`). The renderer-only contract checks builtin Bash attribution (source and path) and row readiness; it does not claim a backend definition identity. Any failed check, unverified version, or non-builtin Bash falls back to the widget path.

No real Pi session or provider check has been performed for this phase.

## Harmless-command checklist

For a manual Pi check: run `/permissions`; turn protection off and run `echo off-ok`; turn on + manual and run `echo manual` (expect confirmation); select auto and run `echo auto` (expect review); with a matching Bash allow rule, run `echo "a; b"` (expect confirmation because of suspicious raw text); verify `git status` runs under its allow rule and `git push origin main` asks; verify untrusted project allows are reported/ignored; save and inspect `~/.pi/pi-auto-approval/auto-permissions.json` and `<cwd>/.pi/pi-auto-approval/history.jsonl`; verify malformed config blocks, then session off bypasses it; start `/new` and confirm session choices clear. Automated tests cover save interleavings; do not treat manual editing before Save as a conflict because Save reads the current value first.
