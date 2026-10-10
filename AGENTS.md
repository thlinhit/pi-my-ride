# AGENTS.md

Monorepo of pi extensions; currently ships `pi-auto-approval` (regex-based approval gates).

## Project map

- `packages/pi-auto-approval/` - the pi extension (`src/gates.ts`, `src/config.ts`, `src/index.ts`; tests in `test/`)
- `docs/` - specs and plans (e.g. `docs/phase-1/plan.md`)

<important if="you need to run tests or other project commands">

| Command | What it does |
|---|---|
| `npm test` | Run `pi-auto-approval` tests (delegates to `packages/pi-auto-approval`) |

</important>

<important if="you are starting a non-trivial change or feature with no spec">

- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them. Don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop, name what's confusing, and ask.
- Draft a markdown spec in `docs/` and confirm it before coding.

</important>

<important if="you are writing new code">

- Write only what was asked. No speculative features, flexibility, or configurability.
- No abstractions for single-use code.
- No error handling for scenarios that can't happen.
- If 200 lines could be 50, rewrite it. Ask: would a senior engineer call this overcomplicated?

</important>

<important if="you are editing existing code">

- Touch only what the request requires. Don't "improve" adjacent code, comments, or formatting.
- Don't refactor code that isn't broken. Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it; don't delete it.
- Remove imports, variables, and functions that your own changes made unused. Leave pre-existing dead code alone unless asked.
- Every changed line should trace directly to the user's request.

</important>

<important if="you are fixing a bug, adding validation, or refactoring">

Define success criteria, then loop until verified:
- Bug fix: write a test that reproduces it, then make it pass.
- Validation: write tests for invalid inputs, then make them pass.
- Refactor: ensure tests pass before and after.

For multi-step tasks, state a plan with a check for each step:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
```

</important>

<important if="you are writing or formatting TypeScript object literals">

- Keep short objects inline when they fit on one line, e.g. `{ id, name }` in a return or a small argument.
- Expand objects with several properties, or ones likely to grow, one property per line. Biome keeps the expanded form when there is a newline after `{`.
- Run `npm run format` before committing formatting changes.

</important>

<important if="you are doing GitHub operations, authenticating, or using git over HTTPS">

- Use the GitHub CLI (`gh`) for GitHub operations, including authentication and repo actions.
- For git over HTTPS, run `gh auth setup-git` to configure Git to use the authenticated CLI.

</important>
