# Contributor agent instructions

Rules for changing **this** monorepo. User-app and framework-usage agent files live in [`ai/`](ai/). Do not copy this file into application repos.

Before any edit, read [`CONVENTIONS.md`](CONVENTIONS.md); before writing or changing a feature or a plugin, also read [`FEATURES.md`](FEATURES.md). When editing a first-party package, also read that package's `AGENTS.md`. Contributions are subject to [`AI_POLICY.md`](AI_POLICY.md).

These rules apply to every task unless explicitly overridden.
Bias: caution over speed on non-trivial work. Use judgment on trivial tasks.

## Agent docs

- `CONVENTIONS.md`, `FEATURES.md`, this file and every package `AGENTS.md` change only when the maintainer explicitly asks for that change. A request to fix or build code is not one. When your work makes a rule wrong or shows one missing, stop and propose the exact wording; do not write it.
- They hold rules: what an agent would get wrong without being told. Not design descriptions, history, or what a lint, a type or a test already enforces. A package `AGENTS.md` never restates a root rule.

## Third-party skills

[`.agents/skills/`](.agents/skills/README.md) holds vendored third-party skills for contributors (`.claude/skills` links to it). They are generic advice; where one conflicts with these files, this repository wins: Vitest, not `node:test`; `.js` imports built with `tsc --build`, not type stripping; the package's check project, not `tsc --noEmit`; oxlint and oxfmt, not ESLint.

Do not edit a vendored skill. Record an unavoidable patch in [`.agents/skills/README.md`](.agents/skills/README.md). The skills shipped to applications live in [`ai/skills/`](ai/skills/), not here.

## Output

Chat in short, plain English. Lead with the answer. No filler.
Keep code names, paths, and error text exact. Do not simplify those.

## Git

- Never commit or push unless asked.
- Branch: `<type>/<topic>`, a Conventional Commits type and a kebab-case topic (`fix/cookie-max-age`). Never an AI tool or model name (`claude`, `codex`, `copilot`, `cursor`, `gemini`, …).
- Conventional Commits: `<type>(<optional scope>): <description>`. Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `perf`. Description under 72 characters, imperative mood, no trailing period.
- No AI attribution in commits, pull requests, comments or reviews: no `Co-Authored-By` naming an assistant, no session link, no "Generated with" line. The contributor is the author of record.
- `make check` green before review; `make lint-markdown` when every changed file is `*.md`.
- Never use `git stash`. If uncommitted changes exist and you need to switch state, stop and ask.
- Never revert, discard, or `git checkout --` a file outside the current task's scope, including files a tool (`oxlint --fix`, `oxfmt`) modified as a side effect. That uncommitted state is other in-progress work: stop and report it.

## Rule 1 — Think before coding

State assumptions explicitly. If uncertain, ask rather than guess.
Present multiple interpretations when ambiguity exists.
Push back when a simpler approach exists.
Before adding code, read its exports, immediate callers and shared utilities. "Looks orthogonal" is dangerous. If unsure why code is structured a way, ask.
Stop when confused. Name what is unclear.

## Rule 2 — Simplicity first

Minimum code that solves the problem. Nothing speculative.
No features beyond what was asked. No abstractions for single-use code.
Test: would a senior engineer say this is overcomplicated? If yes, simplify.

## Rule 3 — Surgical changes

Touch only what you must. Clean up only your own mess.
Do not "improve" adjacent code, comments, or formatting.
Do not refactor what is not broken. Match existing style.

## Rule 4 — Goal-driven execution

Define success criteria. Loop until verified.
If code can answer, code answers: count, search and check with a command, not by reading and guessing.
After every significant step, summarize what was done, what is verified, what is left. Do not continue from a state you cannot describe back.

## Rule 5 — Review your own work

After each significant step, and before you hand over, read your whole diff as a reviewer would. Check that it does what was asked and nothing more, follows these files, has tests that can fail, and leaves nothing behind (debug output, a TODO, a stray file). Fix what you find before you report.

## Rule 6 — Do not spiral

Do not loop on the same failure. If repeated attempts fail, stop and ask.
Say so when you are looping. Do not silently retry.

## Rule 7 — Conventions over taste

Conformance beats taste inside the codebase. If you genuinely think a convention is harmful, surface it. Do not fork silently.
If two patterns contradict, follow these files; where they are silent, the more recent and better-tested one. Explain why, and flag the other for cleanup. Code that contradicts these files is legacy: do not copy it. Do not blend conflicting patterns.

## Rule 8 — Fail loud

"Completed" is wrong if anything was skipped silently.
"Tests pass" is wrong if any were skipped.
Default to surfacing uncertainty, not hiding it.
