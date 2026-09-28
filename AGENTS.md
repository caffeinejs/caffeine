# Contributor agent instructions

Rules for changing **this** monorepo. User-app and framework-usage agent files live in [`ai/`](ai/). Do not copy this file into application repos.

Before any edit, read [`CONVENTIONS.md`](CONVENTIONS.md). When editing a first-party package, also read that package’s `AGENTS.md` (table in `CONVENTIONS.md`). Contributions are subject to [`AI_POLICY.md`](AI_POLICY.md).

These rules apply to every task unless explicitly overridden.
Bias: caution over speed on non-trivial work. Use judgment on trivial tasks.

## Third-party skills

[`.agents/skills/`](.agents/skills/README.md) holds vendored third-party skills for contributors (`.claude/skills` links to it). They are generic advice. Where one conflicts with `CONVENTIONS.md` or a package `AGENTS.md`, this repository wins:

- Tests run on Vitest, not `node:test`.
- Imports use `.js` extensions and packages build with `tsc --build`. No type stripping, no `.ts` import extensions.
- Type-check with the package's check project (`npx tsc --build <pkg>/tsconfig.json`), not `tsc --noEmit`.
- Lint and format with oxlint and oxfmt, not ESLint.
- Checks run in the order of "After every edit" in `CONVENTIONS.md`.

Do not edit a vendored skill. Record an unavoidable patch in [`.agents/skills/README.md`](.agents/skills/README.md). The skills shipped to applications live in [`ai/skills/`](ai/skills/), not here.

## Output

Chat in short, plain English. Lead with the answer. No filler.
Keep code names, paths, and error text exact. Do not simplify those.

## Commits and pull requests

- Conventional Commits: `<type>(<optional scope>): <description>`. Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `perf`.
- Description under 72 characters, imperative mood, no trailing period.
- `make check` green before review; `make lint-markdown` when every changed file is `*.md`.
- Never commit or push unless asked.

## Rule 1 — Think Before Coding

State assumptions explicitly. If uncertain, ask rather than guess.
Present multiple interpretations when ambiguity exists.
Push back when a simpler approach exists.
Stop when confused. Name what is unclear.

## Rule 2 — Simplicity First

Minimum code that solves the problem. Nothing speculative.
No features beyond what was asked. No abstractions for single-use code.
Test: would a senior engineer say this is overcomplicated? If yes, simplify.

## Rule 3 — Surgical Changes

Touch only what you must. Clean up only your own mess.
Do not “improve” adjacent code, comments, or formatting.
Do not refactor what is not broken. Match existing style.

## Rule 4 — Goal-Driven Execution

Define success criteria. Loop until verified.
Do not follow steps. Define success and iterate.
Strong success criteria let you loop independently.

## Rule 5 — Use the model only for judgment calls

Use the model for: classification, drafting, summarization, extraction.
Do not use the model for: routing, retries, deterministic transforms.
If code can answer, code answers.

## Rule 6 — Do not spiral

Do not loop on the same failure. If repeated attempts fail, stop and ask.
Say so when you are looping. Do not silently retry.

## Rule 7 — Surface conflicts, do not average them

If two patterns contradict, pick one (more recent / more tested).
Explain why. Flag the other for cleanup.
Do not blend conflicting patterns.

## Rule 8 — Read before you write

Before adding code, read exports, immediate callers, shared utilities.
“Looks orthogonal” is dangerous. If unsure why code is structured a way, ask.

## Rule 9 — Tests verify intent, not just behavior

Tests must encode why behavior matters, not just what it does.
A test that cannot fail when business logic changes is wrong.

## Rule 10 — Checkpoint after every significant step

Summarize what was done, what is verified, what is left.
Do not continue from a state you cannot describe back.
If you lose track, stop and restate.

## Rule 11 — Match the codebase’s conventions, even if you disagree

Conformance beats taste inside the codebase.
If you genuinely think a convention is harmful, surface it. Do not fork silently.

## Rule 12 — Fail loud

“Completed” is wrong if anything was skipped silently.
“Tests pass” is wrong if any were skipped.
Default to surfacing uncertainty, not hiding it.
