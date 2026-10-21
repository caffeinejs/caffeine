# Contributor agent instructions

Rules for changing **this** monorepo. User-app and framework-usage agent files live in [`ai/`](ai/). Do not copy this file into application repos.

Before any edit, read [`CONVENTIONS.md`](CONVENTIONS.md); before writing or changing a feature or a plugin, also read [`FEATURES.md`](FEATURES.md). A package directory that holds an `AGENTS.md` has rules of its own: read it before editing there. Contributions are subject to [`AI_POLICY.md`](AI_POLICY.md).

These rules apply to every task unless explicitly overridden.
Bias: caution over speed on non-trivial work. Use judgment on trivial tasks.

## Agent docs

- `CONVENTIONS.md`, `FEATURES.md`, this file, every package `AGENTS.md` and the skills written here change only when the maintainer explicitly asks for that change. A request to fix or build code is not one. When your work makes a rule wrong or shows one missing, stop and propose the exact wording; do not write it.
- They hold rules: what an agent would get wrong without being told. Not design descriptions, history, or what a lint, a type or a test already enforces. A package `AGENTS.md` never restates a root rule.
- A rule names a pattern, never a list of files or symbols that grows with the code.

## Rule map

Before you create or edit a file of a kind below, re-read its section, even if you read it at the start of the task.

| Before you create or edit…                                      | Re-read                                   |
| --------------------------------------------------------------- | ----------------------------------------- |
| a test, a test helper or a fixture                              | CONVENTIONS.md § Tests                    |
| a new file or directory, an `index.ts`, a rename                | CONVENTIONS.md § Imports and modules      |
| a feature, a plugin, a builder, an application method, a schema | FEATURES.md                               |
| an `Err*` class or an error message                             | CONVENTIONS.md § Error messages           |
| TSDoc, a README or a doc page                                   | CONVENTIONS.md § Documentation            |
| a span of time or a size in an API                              | CONVENTIONS.md § Durations and byte sizes |
| a `tsconfig*.json` or a `package.json`                          | CONVENTIONS.md § Build and check projects |
| `.github/**`, a Dockerfile or a compose file                    | CONVENTIONS.md § Security                 |
| code that calls a third-party library                           | CONVENTIONS.md § Third-party library docs |
| an agent doc or a skill                                         | AGENTS.md § Agent docs                    |

## Skills

[`.agents/skills/`](.agents/skills/README.md) holds skills for every agent (`.claude/skills` links to it). Load the one the table names before that work. Where a skill disagrees with these files, these files win: Vitest, not `node:test`; `.js` imports built with `tsc --build`, not type stripping; the package's check project, not `tsc --noEmit`; oxlint and oxfmt, not ESLint; checks run in the order of "After every edit" in `CONVENTIONS.md`.

| Before you…                                                                                   | Load                     |
| --------------------------------------------------------------------------------------------- | ------------------------ |
| plan a change to code                                                                         | `plan-change`            |
| hand over a change                                                                            | `review-change`          |
| design or change a public API: an option, a default, a method, a callback, a type users write | `sharp-edges`            |
| write a generic, conditional or mapped type, or fight a type error                            | `typescript-magician`    |
| use a Node.js runtime API: streams, `process`, `node:*` modules, signals, workers             | `node`                   |
| write a Fastify plugin, hook or route                                                         | `fastify-best-practices` |
| touch authentication, cookies, CSRF, crypto or request parsing, or review for vulnerabilities | `security-audit`         |
| write a docs page or a README                                                                 | `documentation`          |
| change an agent doc, a skill or this table                                                    | `skill-optimizer`        |

`plan-change` and `review-change` are written here; the others are vendored. Do not edit a vendored skill. Record an unavoidable patch in [`.agents/skills/README.md`](.agents/skills/README.md). The skills shipped to applications live in [`ai/skills/`](ai/skills/), not here.

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
- A branch your environment assigns that breaks the branch rule above (`claude/…`, `codex/…`) is replaced with a `<type>/<topic>` one: the maintainer's standing permission.

## Rule 1 — Think before coding

State assumptions explicitly. If uncertain, ask rather than guess.
Present multiple interpretations when ambiguity exists.
Push back when a simpler approach exists.
Ask only what the code and these files cannot answer. An option states a choice, never a requirement the user did not give; recommend one.
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
Do not follow steps. Define success and iterate.
Strong success criteria let you loop independently.

## Rule 5 — Use the model only for judgment calls

Use the model for: classification, drafting, summarization, extraction.
Do not use the model for: routing, retries, deterministic transforms.
If code can answer or produce it, code does: count, search, check, convert and generate with a command, because a command's output is exact and can be rerun, and reasoning that imitates it is neither.

## Rule 6 — Do not spiral

Do not loop on the same failure. If repeated attempts fail, stop and ask.
Say so when you are looping. Do not silently retry.

## Rule 7 — Surface conflicts, do not average them

If two patterns contradict, follow these files; where they are silent, the more recent and better-tested one.
Explain why. Flag the other for cleanup.
Do not blend conflicting patterns.
When a rule blocks what the task needs, stop and name the rule; do not work around it.

## Rule 8 — Read before you write

Before adding code, read exports, immediate callers, shared utilities.
Before adding a type, a helper or a context object, find the one that exists and use it, because two names for one concept split every caller. A new one needs the reason none fits.
"Looks orthogonal" is dangerous. If unsure why code is structured a way, ask.

## Rule 9 — Tests verify intent, not just behavior

Tests must encode why behavior matters, not just what it does.
A test that cannot fail when business logic changes is wrong.
Where a test goes and how it asserts is `CONVENTIONS.md` § Tests.

## Rule 10 — Checkpoint after every significant step

Summarize what was done, what is verified, what is left.
Do not continue from a state you cannot describe back.
If you lose track, stop and restate.

## Rule 11 — Match the codebase's conventions, even if you disagree

Conformance beats taste inside the codebase.
If you genuinely think a convention is harmful, surface it. Do not fork silently.
Code that contradicts these files is legacy, even when it sits next to yours: do not copy it, because copying is how it spreads.

## Rule 12 — Fail loud

"Completed" is wrong if anything was skipped silently.
"Tests pass" is wrong if any were skipped.
Default to surfacing uncertainty, not hiding it.

## Rule 13 — Plan against the rules

Before the first edit of a change to code, load `plan-change` and write the plan it asks for: the files and their tests, the existing code reused, the rules that decide it quoted, the skills loaded. A rule read at the start of a task fades by the time it applies; quoted into the plan, it is in front of you when you decide.

## Rule 14 — Review your own work

After each significant step, and before you hand over, run `review-change` on your whole diff, in a fresh context if your tool offers one, because an author reads past their own shortcuts. Check that it does what was asked and nothing more, follows these files, has tests that can fail, and leaves nothing behind (debug output, a TODO, a stray file). Fix what you find before you report.
