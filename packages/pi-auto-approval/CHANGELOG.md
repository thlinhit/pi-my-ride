# Changelog

## Unreleased

- Bash commands with `$'...'` quoting are now matched against rules when every escape is `\n`, `\t`, `\\`, `\'` or `\"`. Any other escape still sends the whole command to review. `echo` is read-only, and so is `date` with no arguments or a single `+FORMAT` argument.
