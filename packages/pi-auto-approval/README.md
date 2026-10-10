# pi-auto-approval

A Pi extension that applies regex-based approval rules to bash tool calls.

## Install

```bash
pi install npm:@thlinhit/pi-auto-approval
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

Each rule requires a non-empty `pattern`, `level` (`guarded` or `convention`), and `label`. Optional `flags` accepts regular-expression flags except `g` and `y`. `convention` rules also require a non-empty `message`.

## Starter rules

Copy [`examples/auto-permissions.json`](examples/auto-permissions.json) to `.pi/auto-permissions.json` to use the starter rules for `git push`, `rm -rf`, and `terraform apply`.

## Behaviour

Rules are checked in order against the raw bash command; the first match wins. `guarded` prompts for approval and blocks if approval is denied or unavailable. `convention` blocks and displays its configured message. Invalid configuration and gate errors block bash calls. With no config or no matching rule, the command is allowed. Non-bash tools are unaffected.

## Limits

This checks raw command text with regular expressions only. It is evadable via quoting, variable expansion, aliases, `eval`, generated or downloaded scripts, shell wrappers, and subshells. It does no command parsing or path resolution. Only the `bash` tool is gated: other tools (including MCP and subprocess-based subagents), user `!`/`!!` commands, and extension `pi.exec` are not. Nested `ctx.executeTool("bash", ...)` does go through `tool_call`. Config is trusted input. This is **not a sandbox and not a security boundary**.
