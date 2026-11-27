# pi-auto-approval

A Pi extension that gates every tool call. Permission rules decide whether a call is denied, needs confirmation, or runs. Calls that no rule matches go to an AI reviewer or to you, depending on the review mode.

## Install

```bash
pi install npm:@thlinh/pi-auto-approval
```

## Local testing

```bash
pi --extension ./packages/pi-auto-approval/src/index.ts
```

## Configuration

Permission rules live in the global file and up to two project files. All use the `permissions` shape. The global file also holds protection, review, reviewer, and UI settings.

| Scope | Path | Holds |
|---|---|---|
| Global | `~/.pi/pi-auto-approval/auto-permissions.json` | `enabled`, `reviewMode`, `permissions`, `reviewer`, `reviewEvidence`, `ui`, `debug` |
| Project, shared | `<cwd>/.pi/pi-auto-approval/auto-permissions.json` | deny and ask rules; `enabled: true`; `reviewMode: "manual"`; `reviewer.softDeny`, `reviewer.hardDeny` |
| Project, local | `<cwd>/.pi/pi-auto-approval/auto-permissions.local.json` | everything the project scope allows: `permissions` (including allow), `enabled`, `reviewMode`, and the `reviewer` lists |
| History | `<cwd>/.pi/pi-auto-approval/history.jsonl` | Tool call log, see [History](#history) |

`<cwd>` is the session's working directory. Files at the older locations (`~/.pi/agent/auto-permissions.json` and `.pi/auto-permissions.json`) are not read. There is no migration.

```json
{
  "enabled": true,
  "reviewMode": "auto",
  "permissions": {
    "allow": ["Bash(git status)"],
    "ask": ["Bash(git push *)"],
    "deny": ["Read(./.env)"]
  }
}
```

### Project files

- **Shared file** (`auto-permissions.json`) is meant to be committed. It may only tighten: deny and ask rules, `enabled: true`, `reviewMode: "manual"`, and `reviewer.softDeny` and `reviewer.hardDeny`. Each of those two lists must include `"$defaults"`.
- **Local file** (`auto-permissions.local.json`) is meant to stay out of git. It may set everything the project scope allows: allow rules, `enabled`, `reviewMode`, and all four reviewer lists.
- **Validation:** both files are always validated, trusted or not. Anything outside a file's column is a config error, and tools are blocked until it is fixed. The error names the local file:

```text
<path>: permissions.allow is not allowed in the shared file; move it to auto-permissions.local.json
```

- **Shared file limits:** the shared file can't set `enabled: false`, `reviewMode: "auto"`, allow rules, `reviewer.environment`, or `reviewer.allow`.
- **Breaking change:** allow rules in `auto-permissions.json` are a config error now. Move them to `auto-permissions.local.json`.
- **Home directory:** if the project folder resolves to the global folder (for example, `cwd` is your home directory), the shared file is skipped, because it is the global file. A separate local file in that folder is read like any other.
- **`.gitignore`:** keep `.pi/` in `.gitignore`, or at least `*.local.json`. Pi does not check this. It assumes `auto-permissions.local.json` is never committed, so its allow rules and reviewer lists are trusted as the user's own.

**What a shared file can and cannot do.** The shared file can only make protection stricter. A deny rule in it applies even when the project is untrusted. It can never override a deny rule from any file, or any configured deterministic denial. A shared ask rule or `reviewMode: "manual"` can route a call to a person. With a UI, that can turn a reviewer hard block into a dialog the user can approve. Its reviewer lists only add categories to the reviewer prompt, which the model may ignore. Project trust is the only boundary for them.

### Starter seed

On the first `session_start` with no global file, the extension creates it with the starter seed below using exclusive creation (`wx`). An existing file is never overwritten or migrated, even if invalid. Installing the package and loading the extension factory do not seed config. Session startup seeds only the global file, never a project file.

A missing global file uses the seed in memory without writing it. If startup cannot create the file, it warns; a genuinely missing file still uses the seed, while an unreadable or invalid config blocks protected calls.

- `allow`: `codemode`, `Bash(git status)`, `Bash(git status --short)`, `Bash(git diff)`, `Bash(git diff --stat)`, `Bash(git diff --check)`, `Bash(git log -5 --oneline)`, `Read(./**)`, `Read(~/.pi/agent/git/**/SKILL.md)`
- `ask`: `Bash(git push)`, `Bash(git push *)`, `Bash(git reset)`, `Bash(git reset *)`, `Bash(git clean)`, `Bash(git clean *)`, `Bash(rm)`, `Bash(rm *)`
- `deny`: `Bash(security)`, `Bash(security *)`, `Read(./.env)`, `Read(./.env.*)`, `Read(./secrets/**)`, `Edit(./.env)`, `Edit(./.env.*)`, `Edit(./secrets/**)`, `Read(./**/.env)`, `Read(./**/.env.*)`, `Read(./**/*.pem)`, `Read(./**/*.key)`, `Read(~/.ssh/**)`, `Read(~/.aws/**)`

`Read(./**)` lets agents read any file in the current project without review. Deny rules still win, so the secret patterns above stay blocked. Deny and ask rules match both the written path and the resolved path. Allow rules match only the resolved path.

The shipped [`examples/auto-permissions.json`](examples/auto-permissions.json) has the same content. No example or seed is copied into projects automatically.

### Rule grammar

A rule is a tool name, optionally followed by a specifier in parentheses: `Tool` or `Tool(specifier)`.

- Built-in tool names are case-insensitive: `bash`, `read`, `edit`, `write`, `grep`, `find`, `ls`, `powershell`.
- Other tool names match exactly. They take no wildcard and no specifier.
- Only `Bash`, `Read`, `Edit`, and `Write` take a specifier. Any other specifier is a config error.
- The specifier runs from the first `(` to the final `)`. Parentheses inside it are literal.
- Leading and trailing whitespace around a rule is ignored. A blank rule or blank specifier is a config error.

**Bash deny and ask** rules match the whole raw command. `*` is the only wildcard, and it matches any text, including spaces and `/`. Everything else is literal. `Bash(git push *)` matches `git push origin main` and `git push`, and does not match `git status`. Deny and ask rules also match:

- the command with a leading `env` (optionally followed by `NAME=value` words), `command`, or `exec` removed. `bash -c` and `eval` are not unwrapped. So `Bash(rm *)` matches `env FOO=1 rm -rf x`.
- the bare command, for a rule that ends in ` *`. So `Bash(git push *)` matches `git push`.
- a canonical form of supported components, on both sides. Quotes and backslash escapes are removed, and the words are joined by single spaces. So a deny on `Bash(rm -rf /tmp/x)` also denies `rm -rf '/tmp/x'`, and a deny on `Bash(preview draft\ note)` also denies `preview "draft note"`.

**Bash allow** rules match command words, not raw text, so quoting doesn't matter. The rule is split on unquoted spaces. Quotes group text with spaces and are removed, and wildcards still work inside them. Then:

- A rule word that is exactly `*` matches any number of whole command words, including none.
- Any other rule word matches exactly one command word. Inside it, `*` matches within one path segment and `**` matches across `/`. Other characters are literal.
- A key repeated in the command is not matched. If a rule word has the form `key=…` or `--key=…`, and the command has more than one word that starts with that key, the rule doesn't match. `--key value` (space-separated) is not checked.
- A `..` path segment is not matched. If a rule word contains `/` and the command word it matches has a `..` segment in its value (after any `key=`), the rule doesn't match.

For example, with this rule:

```text
Bash(obsidian vault=X create path="1. Inbox/Work/*" *)
```

| Command | Result |
|---|---|
| `obsidian vault=X create path="1. Inbox/Work/a.md" content=$'l1\nl2'` | allowed |
| `obsidian vault=X create path="1. Inbox/Work/sub/a.md"` | not matched, goes to review. Use `Work/**` to allow subfolders |
| `obsidian vault=X create path="1. Inbox/Personal/a.md"` | not matched, goes to review |
| `obsidian vault=X create path="1. Inbox/Work/a.md" path="Secrets/x.md"` | not matched, repeated `path=` |
| `obsidian vault=X create path="1. Inbox/Work/../../Private/x.md"` | not matched, `..` segment |

Slashes in a trailing ` *` are fine, so `content=$'see a/b/c'` matches. With `content=*` in place of a trailing ` *`, `content="a/b"` doesn't match; write `content=**`.

**Compatibility changes:**

- `Bash(cat src/*)` no longer matches `cat src/a/b.ts`. Use `Bash(cat src/**)`.
- `Bash(git diff*)` no longer matches `git diff --stat`, because `*` inside a word doesn't match further words. Use `Bash(git diff *)`.

Such calls now go to review (or to a dialog in manual mode). Exact allows such as `Bash(git status)` are unchanged.

**Size limit.** The limit is 65,536 UTF-8 bytes of the whole original call. Over it, deny and ask rules still match, but allow rules and read-only detection don't match any component, so every component goes to review.

For supported Bash syntax, each parser-derived component is checked separately, and a whole-command allow never bypasses component checks. Explicit component allows satisfy review, so separate `Bash(git status)` and `Bash(git diff)` allows permit `git status; git diff`.

The supported subset is simple commands with literal words, single quotes, `$'...'` quotes that use only the escapes `\n`, `\t`, `\\`, `\'`, and `\"`, safe double-quoted literals and escapes, joined by `;`, `&&`, `||`, `|`, newline, or background `&`. Comments and line continuations are supported. Any other escape inside `$'...'`, such as `\x2d` or `\u002f`, makes the command unsupported.

Valid syntax outside that subset, including expansions, substitutions, assignments, redirections, heredocs, loops, functions, grouping, subshells, negation, arithmetic and conditionals, is unsupported. Unsupported input is covered under [Review and controls](#review-and-controls). Malformed, empty or comment-only, NUL, invalid Unicode, and CR/CRLF input always require confirmation. The parser treats CRLF differently from Bash, so CR input is deliberately excluded from model review.

**Read, Edit, and Write** patterns are matched against the resolved path:

- Tool input paths expand `~` and `~/`, strip one leading `@`, decode `file://` URLs, and treat Unicode space characters as ASCII spaces. Relative paths resolve against the session's working directory.
- Configured patterns resolve relative to the session's working directory, not the config file's directory. `~/` and `file://` patterns are supported. Only stars written in the pattern are wildcards; characters in the working-directory and home-directory prefixes stay literal.
- `*` matches within one path segment. `**` matches across segments.
- `Edit(...)` also covers `Write`. `Read(...)` covers only `Read`.
- Absolute paths inside the project match file rules. `Read(./.env)` also matches the absolute path of `.env` under the session directory.
- `Read` mirrors Pi's native Read fallbacks. If the path as written does not exist, it also tries U+202F instead of the space before `AM.`/`PM.`, the NFD form, the curly-apostrophe form, and the NFD plus curly-apostrophe form. `Edit` and `Write` do not use these fallbacks.

Deny and ask file rules match the lexical path and the resolved path, compared case-folded and Unicode-normalized (NFC). Allow file rules match only the resolved path, compared case-sensitively. Folding is never used to grant access. Symlinks are followed when resolving a path. A call whose path can't be resolved is treated as matching a deny or ask rule, but never as matching an allow rule.

### Precedence and trust

- Across all rules, `deny` beats `ask`, and `ask` beats `allow`, regardless of file order.
- Within one level, rules are checked in this order: global, then shared, then local. Within each scope, the first matching entry supplies the displayed rule and source.
- In an untrusted project, the settings, allow rules, and reviewer lists from both project files are ignored. Deny and ask rules from both files still apply. A notice names each file once per session:

```text
Ignored project settings from <file> because the project is untrusted.
```

- A project allow cannot weaken a global deny or ask. A project deny can still block a global allow, and a project ask can require confirmation for one.
- The effective `enabled` and `reviewMode` values come from the first of these that is set: session choice, then local file, then shared file, then global. Project values apply only when the project is trusted.

### `reviewMode`

Unmatched calls use `reviewMode`, which defaults to `"auto"`. It can be set in the global file, in the shared file (only as `"manual"`), or in the local file.

- `auto` sends unmatched calls to the AI reviewer.
- `manual` asks you for every unmatched call and never calls the reviewer. An explicit `"manual"` is a human-only override.

### Config errors

A missing global file uses the starter seed; a missing project file adds no rules. Invalid JSON, invalid schema, and read failures other than a missing file are config errors. A config error blocks every protected tool call, not just Bash:

```text
auto-approval: invalid config - <error>. Fix it to run tools.
```

Errors include unknown keys, an object where a string is expected, a bad rule, and removed keys such as `permissions.defaultMode` and the legacy `rules` key:

```text
<path>: unsupported field "rules"
```

Old rule objects with `pattern`, `label`, `level`, `flags`, or `message` are not accepted. Rewrite them as `permissions` strings by hand.

## Review and controls

Each tool call is checked in this order:

1. **Session protection off**: bypasses config validation and gating.
2. **Config error**: blocked, see above. Otherwise, effective `enabled: false` bypasses gating unless the session explicitly turns protection on. See [Precedence and trust](#precedence-and-trust).
3. **Built-in hard deny**: a recursive `rm` of root, home, or a listed system folder is blocked with no dialog. Nothing else can override it. See [Built-in hard deny](#built-in-hard-deny).
4. **Deny match**: a deny rule that matches the whole command or any of its components blocks the call. No review.
5. **Supported Bash**: check each component. Component allows pass. Ask rules, soft denies, revisions, and failed reviews are collected. Each unmatched component uses `reviewMode` below, except read-only components, which pass without review in either mode. A reviewer `hard_deny` blocks the call at once. Reviews run serially in source order. A reviewer revision offers one-shot confirmation of the original action; cancellation stops immediately. A whole-command ask rule adds its reason to the same confirmation. If nothing blocked, all collected reasons produce one confirmation showing the full original command. No components are executed by the gate.
6. **Unsupported Bash**: deny and ask rules are checked with a conservative scan of each command segment. A deny match blocks. An ask match requires confirmation without review. Otherwise, valid unsupported Bash goes to the reviewer in auto mode, and asks in manual mode. Malformed input always asks. Allow rules never skip review.
7. **Other tools**: ask requires confirmation without review; allow runs without review. For unmatched calls, and unmatched supported Bash components that are not read-only, `reviewMode` decides.
   - `manual`: confirmation required. No reviewer call.
   - `auto`: the reviewer decides, using the [reviewer policy](#reviewer-policy). Approve runs the call. A reviewer hard deny blocks it with no dialog. Soft deny and revise ask you. Reviewer errors and timeouts ask you.

Read-only components are `cd`, `pwd`, `ls`, `cat`, `nl`, `head`, `tail`, `wc`, `grep`, `echo`, `rg` (without `--pre`), `find` (without write actions), `sed -n` with a print-only script, and `date` with no arguments or one `+FORMAT` argument. Commands with redirections or other shell operators are never read-only.

**Guard config is always asked.** A Write or Edit to a path inside the global config folder, or inside `<cwd>/.pi/pi-auto-approval/`, always asks. Paths are resolved through symlinks, then compared case-folded and Unicode-normalized (NFC). No allow rule, read-only check, or reviewer verdict skips this dialog, and the reviewer is not asked about it. A Bash command whose text contains `pi-auto-approval` or `auto-permissions`, ignoring case, asks too. In a supported compound, only that component is treated this way, and it is not sent to the reviewer. The other components are checked as usual. This check is best effort: `cd` and variables can get around it. Without a UI, every such call is blocked. The reason shown is `Changes auto-approval protected file <path>`. If a deny rule also matches the same call, the call is blocked with no dialog.

**Sensitive files are always asked too.** A Write or Edit to one of these files, or a Bash command that writes one of them, asks with the reason `Changes sensitive file <path>`. Without a UI, the call is blocked with the `protected path` source:

- `~/.zshrc`, `~/.zprofile`, `~/.zshenv`, `~/.bashrc`, `~/.bash_profile`, `~/.profile`, `~/.config/fish/config.fish`, `~/.ssh/authorized_keys`

Write and Edit match the resolved path: symlinks are followed, then the path is compared case-folded and Unicode-normalized (NFC). Bash matches the target of any output redirect (`>`, `>>`, `>|`, `&>`, `&>>`, and `>&` with a file target, including fd-prefixed forms such as `2>`) and the arguments of `tee`. A leading `~` or `$HOME` means the home folder. Reads such as `cat ~/.zshrc` or `grep PATH ~/.zshrc` don't ask. Like the guard check, this is best effort for Bash: `cd` and other variables can get around it.

Every block returned to the agent reads:

```text
Blocked by auto-approval (<source>): <reason>
The tool did not run. Do not claim it succeeded. You may take a different approach that stays within policy, but do not retry this action another way (other syntax, another tool, or a script).
```

The source is `deny rule`, `protected path`, `hard deny`, `reviewer`, `no UI`, `user`, `config`, `error`, or `cancelled`.

Already-cancelled calls and malformed Bash input fail closed before the protection-off checks. Any confirmation blocks when no UI is available. Confirmations for unmatched calls read `Unmatched Bash command` or `Unmatched <tool> call`.

For supported Bash, the reviewer sees the current component, full original command, index/count, source span, and enclosing list, conditional, pipeline and background context. The cwd is initial context only. Preceding commands have not executed and may change shell state; the gate neither executes them nor simulates their effects. For other tools it sees the tool name and its full arguments, which are untrusted content. Confirmation dialogs for other tools show the tool name and a truncated argument excerpt. The full arguments still go to the reviewer.

**Cost:** every unmatched supported Bash component that is not read-only is reviewed in auto mode. A compound call can cost multiple reviews. Other unmatched calls, including reads, searches, and listings, each cost one review. Add `allow` rules for frequent safe calls, or use manual mode.

Use `/permissions` in the interactive TUI (not RPC, print or JSON mode). Four current-value rows stay open: **Permission**, **Review mode**, **Reviewer model**, **Debug**. Up/Down navigates; Enter toggles or opens the reviewer picker. Picker selection or cancellation returns to the same row. Changes are session-local until **Ctrl+G — Save globally** atomically saves all four values. **Ctrl+R — Reset session changes** clears all overrides and reloads configuration without writing; project rules and validation still apply. Save and reset preserve row selection. Escape/Ctrl+C exits without saving or undoing changes. All session starts (`startup`, `reload`, `new`, `resume`, `fork`) discard unsaved overrides. Save writes only global configuration, preserves unrelated fields, and refuses invalid or concurrently changed targets. A failed save retains session choices and previous saved bytes. External edits to config files take effect on the next tool call. A protection or review-mode change cancels and blocks pending attempts. Explicit session-level protection off bypasses config validation and this extension's gating. Turning it back on restores validation.

The protection footer shows `🛡️ guardian: off`, `🛡️ guardian: auto`, or `🛡️ guardian: manual`. Setting `ui.status: false` hides valid-config status. Invalid configuration shows `⚠ protection config error · tools blocked`, unless protection is explicitly disabled for the session, which shows `🛡️ guardian: off`.

### Built-in hard deny

The built-in hard deny is fixed in code. While protection is on, it runs first, before deny rules, protected paths, read-only detection and the reviewer. No rule, reviewer verdict or dialog overrides it, and no setting turns it off on its own. Turning the whole guard off (`enabled: false` or `/permissions`) skips it too. A match blocks with no dialog and the `hard deny` source.

It checks every simple command in a Bash command that parses, including unsupported syntax. Leading `sudo`, `env` (with `NAME=value` words), `command` and `exec` are removed first. It matches `rm` with a recursive flag (`-r`, `-R`, `--recursive`, or a short flag that contains `r` or `R`, such as `-rf`) and one target word, taken literally with no expansion:

- root: `/`, `/*`
- home: `~`, `~/`, `~/*`, `$HOME`, `${HOME}`, and the literal home folder, each also with a trailing `/` or `/*`
- system folders: `/bin`, `/boot`, `/dev`, `/etc`, `/lib`, `/lib64`, `/opt`, `/proc`, `/root`, `/sbin`, `/sys`, `/usr`, `/var`, `/System`, `/Library`, `/Applications`, `/Users`, `/home`, each as itself, with a trailing `/`, or with `/*`

It doesn't match deeper paths (`~/.cache`, `/var/folders/x`, `/tmp/build`), top-level folders not on the list (`/app`, `/workspace`), or quoted text passed to another command, such as `obsidian create content="never run rm -rf ~"`.

Known misses. These calls are not hard-denied and go through the normal flow:

- No `cd` tracking: `cd / && rm -rf *` is not matched.
- Only `rm`: `find ~ -delete` and `python -c "shutil.rmtree(...)"` are not matched.
- Wrappers with options: `sudo -u root rm -rf /`, `env -i rm -rf ~`, and `command -p rm -rf ~` are not stripped, so they are not matched.
- Installer pipelines: a `curl … | sh` that edits `.zshrc` itself. The gate never sees that write.

## History

Each gated tool call appends one JSON line to `<cwd>/.pi/pi-auto-approval/history.jsonl`. The directory is created if needed.

```json
{"time":"2026-10-16T09:30:00.000Z","tool":"bash","command":"git push origin main","decision":"blocked","by":"headless","reason":"Blocked by auto-approval (no UI): Requires confirmation (Bash(git push *), /work/app/.pi/pi-auto-approval/auto-permissions.json)\nThe tool did not run. Do not claim it succeeded. You may take a different approach that stays within policy, but do not retry this action another way (other syntax, another tool, or a script)."}
```

- `time`: ISO 8601 timestamp in UTC, taken when the record is written.
- `tool`: the tool name, as Pi reports it.
- `command`: for `bash`, the command text after redaction. For `read`, `edit`, and `write`, the `path` argument as the tool received it, unresolved. For other tools, the string `command` input if present, otherwise `""`.
- `decision`: `"approved"` when the gate let the call proceed, through an allow rule, an approval, or a reviewer approval. `"blocked"` when the gate stopped it. This is the gate result only. It does not show whether the tool then succeeded or failed.
- `by`: what decided the call. It is one of:
  - `config`: the config couldn't be loaded or was invalid, or the gate couldn't check the call (malformed Bash input, a rule-matching error).
  - `deny-rule`, `allow-rule`: a matching rule.
  - `hard-deny`: the built-in hard deny blocked the call.
  - `read-only`: a read-only component passed without review.
  - `protected-path`: guard config or a sensitive file was touched.
  - `reviewer`: the reviewer approved or blocked.
  - `user`: you answered a dialog.
  - `headless`: a confirmation had no UI, so it was blocked. Protected-path confirmations record `protected-path` instead.
  - `cancelled`: the call was aborted, or the confirmation dialog failed before you answered.
- `reason` (optional): for a block, the full block message returned to the agent; for a reviewer approval, the reviewer's reason. Absent otherwise. Secrets are redacted the same way as in `command`.

A block takes the `by` of the step that blocked it: deny rule, protected path, built-in hard deny, reviewer `hard_deny`, or config. A confirmation with no UI records `headless`, except a protected-path confirmation, which records `protected-path`. A dialog result is `user`, whether you approve or decline. An abort is `cancelled`. An approval with no dialog takes the strongest step any component used, in this order: `reviewer`, then `allow-rule`, then `read-only`.

History holds no reviewer transcripts, provider records, or displayed text. Only the `reason` fields carry reviewer or rule text.

**Redaction is best effort.** Before writing, `command` and `reason` are redacted. Replaced values become `[REDACTED]`. The redaction covers:

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

### Reviewer policy

The reviewer answers with a verdict, a tier, and a reason:

| Verdict | With UI | Without UI |
|---|---|---|
| `approve` | run | run |
| `block`, tier `hard_deny` | blocked, no dialog | blocked |
| `block`, tier `soft_deny` | ask you, showing the reason | blocked |
| `revise` | ask you, showing the constraint | blocked |

If the reply can't be parsed, or its tier doesn't fit its decision, the reviewer is asked once more in the same review. A second bad reply, a provider error, or a timeout fails closed: you are asked, and the call is blocked when there is no UI. An `approve` is valid with tier `allow`, `user_intent`, or `none`. A `block` is valid with `hard_deny` or `soft_deny`. A `revise` is valid with `none` and must name the `constraint` it breaks and its `source`.

The reviewer applies these steps in order:

1. An action matching `hardDeny` is blocked with tier `hard_deny`. No allow entry or user message overrides it.
2. An action matching `softDeny` is blocked with tier `soft_deny`, unless an `allow` entry covers it or a user message authorizes it. A user authorization must name this specific action, or a bounded set that clearly includes it. A general request such as "clean up the repo" does not authorize a soft-deny action. A later user message can narrow or withdraw an earlier authorization.
3. An action that breaks a concrete user constraint is revised, with tier `none`.
4. Otherwise the action is approved. Medium-risk actions don't need explicit authorization, and the reviewer doesn't invent risks that no list names.

A hard deny wins over a constraint violation, because step 1 runs first.

Destinations are never trusted because the action, the assistant, or a tool result names them. An unknown destination stays `softDeny` unless trusted `environment` configuration names it.

### Reviewer lists

The reviewer has four prose lists. Each is an array of non-empty strings, and you can set them in the global file, the shared file, or the local file:

```json
"reviewer": {
  "environment": ["$defaults", "Obsidian vault \"X\" (obsidian CLI, vault=X) is this bot's notes store"],
  "allow": ["$defaults", "Creating notes in vault X under 1. Inbox/Work/ or 2. Projects/Work/"],
  "softDeny": ["$defaults", "Creating, moving or deleting notes in vault X outside 1. Inbox/Work/ and 2. Projects/Work/"],
  "hardDeny": ["$defaults"]
}
```

- `environment`: what the reviewer treats as trusted. The defaults are "the session working directory and its git remotes are trusted" in a trusted project, and "the session working directory is trusted" in an untrusted one. Remotes are never looked up.
- `allow`: actions the reviewer may approve without asking. There are no default entries.
- `softDeny`: defaults cover destructive or hard-to-reverse actions (deleting files, `git reset --hard`, history rewrites); force-pushes or pushes to the default branch; uploads or sends to hosts not in `environment`; writes outside the working directory and `environment`; and production deploys or changes to shared infrastructure.
- `hardDeny`: defaults cover secret or credential exfiltration; disabling, editing, or bypassing this guard; and broad irreversible destruction, such as wiping a disk or bucket.

**Merging.** Lists merge for each field separately. The layers are the global file, then the shared file (trusted projects only), then the local file (trusted projects only).

- A layer that omits a field adds nothing.
- `"$defaults"` expands to that field's built-in list.
- The result is every layer's entries, in order, with duplicates removed.
- If no layer sets a field, the built-in list is used.

So a field's built-in list is replaced only when no layer includes `"$defaults"`. The shared file must include `"$defaults"` in `softDeny` and `hardDeny`, so a trusted shared file always brings the defaults back. Project entries are extra categories. They can't remove or override built-in or global entries.

Changing any list starts a new reviewer session.

### Evidence

Reviewer evidence includes the session's user messages, assistant text (labelled as non-authorizing), and the bash commands it ran. An earlier Write, Edit, or Read call appears only as its path, such as `TOOL write path=scratch/a.md`. Its content is never shown. The reviewer also sees project instructions when `reviewEvidence.projectInstructions` is on.

Reviews are not isolated from one another. A request the reviewer has already seen in full stays in its cached conversation, so its content can still shape later reviews.

Reviewer model selection is the **Reviewer model** item in `/permissions`. It lists available chat-model entries from Pi's registry (`getAvailable`), in registry order, excluding providers without configured authentication. Each label is numbered (`1. provider/id`) because provider/id labels can collide, so every entry is reachable. Availability follows Pi's configured-provider snapshot; it does not guarantee reachability or a successful review. Classifier and image models are separate operation types and are not reviewer inputs. Choosing an entry sets a session override; Ctrl+G persists it with the other menu values in one staged replacement. A failed save retains both the previous saved bytes and session choices. This is not a cross-process lock or a crash-durability guarantee. **Use active model** overrides any saved pair for this session; Ctrl+G removes the saved pair. Each later review uses the live conversation model, including subsequent model changes. Selection changes affect future attempts only. Selecting a reviewer does not cancel an active review, a queued attempt that already captured its settings, or a pending confirmation. If the selected reviewer is unusable (for example, not found in the registry, or without configured auth), the review error is shown and the human is asked to confirm; without UI the attempt is blocked. The reviewer never substitutes the active model or another model. There is no automatic reviewer selection.

Reviewer sessions are reused with stable `sessionId` and `cacheRetention: "long"`; reviews are serialized. Reuse resets when model/session/instructions/evidence change, evidence is no longer an unchanged prefix, prompt usage reaches budget, or a review fails or is cancelled. The reviewer caps estimated prompt size at 80% of context window (128,000 tokens by default) and does not truncate history; overflow falls back to confirmation, and blocks without UI. Evidence lineage and cache data are advisory, not authoritative; compaction summaries can omit constraints. Project instructions are opt-in via `reviewEvidence.projectInstructions: true`, include only trusted-project `AGENTS.md` (otherwise `CLAUDE.md`) in the system prompt, and never authorize commands.

**Limits.** Rules and review are guardrails, not a sandbox or a security boundary. They are advisory.

- Bash patterns match command text only. Absolute shell binaries (for example `/usr/bin/security`), wrappers, `sudo`, scripts that run other commands, and other indirect execution do not match `Bash(...)` rules. `Bash(security)` does not stop `/usr/bin/security find-generic-password`.
- PowerShell is not a Bash-pattern target. A PowerShell call is gated only by a bare `powershell` rule (an exact tool match with no specifier) or by an unmatched review.
- Absolute in-project file paths do match file rules, as described above.
- File matching does not cover paths that reach denied files through other routes.
- `--key value` (space-separated) arguments are not checked by allow rules, so a repeated key in that form can still match.
- Not gated: user `!` and `!!` commands, direct filesystem or network access inside other extensions, and `pi.exec` from extensions.
- Config files can be changed by the agent through allowed tools, or outside Pi. Config is read on every tool call.
- Redaction is best effort. History is not an audit log.

No manual real-Pi or real-model check has been performed for this phase. The statements above come from automated tests and the implementation.

## Automated coverage

Run `npm test && npm run typecheck` from the repository root. Tests cover strict global/project and nested validation; the rule grammar, precedence, trust, path normalization, attribution, parser-derived components and unsupported fallback; manual/auto/off routes; all five session resets; pending human/model cancellation, late approvals and dialog-lock retention; external-edit selection snapshots; and save conflicts from modification, deletion or appearance. History tests cover the exact record fields, redaction forms, and warning-only write failures. Phase 4 reviewer evidence, budget, cache and lineage tests remain, including five-step comparisons against fresh reviews. Reviewer-selection tests cover the atomic global save (partial-write, rename, and external-change failures), the `/permissions` picker, and routing through the real extension loader and Pi's real model registry and auth path: the real `getAvailable` listing (excluding unconfigured providers), `find` resolution, an unregistered selected model, and a selected provider losing configured auth, which reports Pi's own not-configured error. UI replies and successful provider replies are controlled doubles. These tests do not establish live TUI usability, real-model approval quality, or live Pi behavior.

## Review status visibility

Per-tool review status (editor widgets and inline tool rows) is hidden by default. `/permissions` shows the effective **Debug: off/on** value; selecting it toggles visibility for this session only. **Ctrl+G** persists the effective choice as the global-only boolean `debug` (default `false`), together with the other menu values. **Ctrl+R** and every session start discard unsaved debug overrides.

Turning debug off clears current review indicators, including pending and completed rows, without cancelling reviews or changing approvals. Turning it on does not restore past indicators. Review indicators require both debug and `ui.status: true`; `ui.status: false` still suppresses them. Debug does not change the guardian footer, approval dialogs, errors, history, or tool execution.

## Phase 5 tool-row status

Tool-row status is an opt-in renderer adaptation. It calls Pi's public `registerToolRenderer` resolver and `next()` to wrap only the native Bash `renderCall`; Bash execution and native `renderResult` remain unchanged. The extension checks the installed Pi version and current builtin Bash identity before using a row, and otherwise falls back to the editor widget.

Automated native-renderer evidence is recorded in [`docs/phase-5/verification.md`](../../docs/phase-5/verification.md). It uses the public `createBashToolDefinition`, `ToolExecutionComponent`, and renderer APIs. Tool-row status is admitted only for exact tested Pi version `1.2.0` (`VERIFIED_PI_VERSIONS` in `src/ui/rows.ts`). The renderer-only contract checks builtin Bash attribution (source and path) and row readiness; it does not claim a backend definition identity. Any failed check, unverified version, or non-builtin Bash falls back to the widget path.

No real Pi session or provider check has been performed for this phase.

## Harmless-command checklist

For a manual Pi check: run `/permissions`; turn protection off and run `echo off-ok`; turn on + manual and run `echo manual` (expect confirmation); select auto and run `echo auto` (expect review); with a matching Bash allow rule, run `echo "a; b"` (expect no confirmation, because the semicolon is quoted data); with separate allows for `printf 'a'` and `printf 'b'`, run `printf 'a';printf 'b'` (expect `ab` from the unchanged original call); verify `git status` runs under its allow rule and `git push origin main` asks; verify untrusted project allows are reported/ignored; save and inspect `~/.pi/pi-auto-approval/auto-permissions.json` and `<cwd>/.pi/pi-auto-approval/history.jsonl`; verify malformed config blocks, then session off bypasses it; start `/new` and confirm session choices clear. Automated tests cover save interleavings; do not treat manual editing before Save as a conflict because Save reads the current value first.
