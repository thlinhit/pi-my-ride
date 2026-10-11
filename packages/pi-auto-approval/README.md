# pi-auto-approval

A Pi extension that applies regex-based approval rules to bash tool calls.

## Install

```bash
pi install npm:@thlinhit/pi-auto-approval
```

## Local testing

Run Pi with the extension loaded directly from this repository:

```bash
pi --extension ./packages/pi-auto-approval/src/index.ts
```

## Config

Create `.pi/auto-permissions.json` in the project working directory. If absent, the extension uses `~/.pi/agent/auto-permissions.json`. The project file replaces global rules entirely, including when it contains an empty rules array.

```json
{
  "rules": [
    { "pattern": "\\bgit\\s+push\\b", "level": "guarded", "label": "git push" },
    { "pattern": "\\brm\\s+-[a-zA-Z]*r[a-zA-Z]*f|\\brm\\s+-[a-zA-Z]*f[a-zA-Z]*r", "level": "guarded", "label": "recursive force removal" },
    { "pattern": "\\bterraform\\s+apply\\b", "level": "guarded", "label": "terraform apply" }
  ]
}
```

Each rule requires a non-empty `pattern`, `level` (`guarded` or `convention`), and `label`. Optional `flags` accepts regular-expression flags except `g` and `y`. `convention` rules also require a non-empty `message`. An optional non-empty `group` can be set on a rule; it only affects `guarded` rules.

## Trusted groups

List trusted group names, one per line, in the project file `.pi/trusted-ops`. Names are trimmed, blank lines ignored, and matching is exact and case-sensitive. This file is project-only and read fresh on every bash call. A trusted group bypasses confirmation for matching `guarded` rules only; `convention` rules always block.

```json
{ "pattern": "\\bgit\\s+status\\b", "level": "guarded", "label": "git status", "group": "git" }
```

## Status widget

For matched rules, the temporary widget shows `reviewing` during model review or confirmation, then `approved` or `blocked`. A trusted guarded match shows `approved`; convention matches show `blocked`. Set `"ui": { "status": false }` in `.pi/auto-permissions.json` to hide the widget. It is shown by default. This setting does not change enforcement.

## Starter rules

Copy [`examples/auto-permissions.json`](examples/auto-permissions.json) to `.pi/auto-permissions.json` to use the starter rules for `git push`, `rm -rf`, and `terraform apply`.

## Behaviour

Rules are checked in order against the raw bash command; the first match wins. `guarded` commands are reviewed by the configured model by default. An approval runs the command; a revision blocks it; uncertain or failed reviews require user confirmation and block when confirmation is unavailable. `convention` blocks and displays its configured message. Invalid configuration and gate errors block bash calls. With no config or no matching rule, the command is allowed. Non-bash tools are unaffected.

## Limits

Guardian relies on model judgment and is advisory, not a security boundary. Every untrusted guarded command incurs a model request and its latency. Reviewer sessions are reused: the first review sends full evidence, later reviews append a delta with a stable `sessionId` and `cacheRetention: "long"`; reviews are serialized. Reuse resets when the model/session/reviewer instructions/trust changes, evidence is no longer an unchanged prefix, prompt usage reaches the budget, or a review fails or is cancelled. The reviewer caps estimated prompt size at 80% of the context window (128,000 tokens by default) and does not truncate history; overflow falls back to Allow/Block confirmation, and blocks without UI. History comes from Pi's compaction-aware context, so compaction summaries are non-authoritative and can drop a constraint. Images are placeholders. Provenance is not a security boundary because configuration and other extensions can inject user messages. No manual real-model check, live cache-read benchmark, or fresh-versus-reused verdict comparison has been done.

Project instructions are opt-in with `reviewEvidence.projectInstructions: true` (off by default) and are included only when Pi marks the project trusted. `AGENTS.md` is used when present, otherwise `CLAUDE.md`; the selected file is included in the reviewer's system prompt, never authorizes a command, and changes reset session reuse. Planted instructions, noise, token cost, and stale rules are risks. Enable this only when project instructions describe normal and safe commands.

Set `"guardian": "off"` to restore plain confirmation for guarded commands. Reviewer settings are optional: `provider` and `model` must be supplied together (otherwise the active model is used), `reasoningEffort` defaults to `"low"`, and `timeoutMs` defaults to `30000` (valid range 1000–300000). Supply either non-blank `extraInstructions` or `extraInstructionsFile`, not both; file paths are relative to the config file and their text is appended as additional constraints.

This checks raw command text with regular expressions only. It is evadable via quoting, variable expansion, aliases, `eval`, generated or downloaded scripts, shell wrappers, and subshells. It does no command parsing or path resolution. Only the `bash` tool is gated: other tools (including MCP and subprocess-based subagents), user `!`/`!!` commands, and extension `pi.exec` are not. Nested `ctx.executeTool("bash", ...)` does go through `tool_call`. Config is trusted input. This is **not a sandbox and not a security boundary**.

`trusted-ops` grants broad trust: use it only in projects you control. Anyone who can write the project can write this file, including the agent through its own tools, so it is not a security boundary. Convention rules are never bypassed. The status widget is cosmetic; widget failures do not affect enforcement. Trusted guarded commands can run even without a UI.
