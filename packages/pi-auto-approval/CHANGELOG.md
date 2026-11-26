# Changelog

## Unreleased

- Bash commands with `$'...'` quoting are now matched against rules when every escape is `\n`, `\t`, `\\`, `\'` or `\"`. Any other escape still sends the whole command to review. `echo` is read-only, and so is `date` with no arguments or a single `+FORMAT` argument.
- **Breaking:** a project can now have two config files in `.pi/pi-auto-approval/`. `auto-permissions.json` is meant to be committed and may only add deny and ask rules, `enabled: true` and `reviewMode: "manual"`. `auto-permissions.local.json` is meant to stay out of git and may also set allow rules, `enabled` and `reviewMode`. Project allow rules in `auto-permissions.json` are now a validation error, so move them to `auto-permissions.local.json`. Settings and allow rules from either file apply only when the project is trusted. Deny and ask rules always apply.
- Writes and edits to the guard's own config always ask, even with a matching allow rule, and are blocked when there's no UI. Bash commands that mention `pi-auto-approval` or `auto-permissions` ask too. Paths are compared after following symlinks, ignoring letter case and Unicode spelling.
- File deny and ask rules now also match the path after following symlinks, ignoring letter case and Unicode spelling. File allow rules match only the real path after following symlinks, with letter case kept, so an allow rule that names a symlinked path may now send the call to review.
