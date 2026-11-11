# Contributor agent instructions

Rules for changing **this** monorepo. User-app and framework-usage agent files live in [`ai/`](ai/). Do not copy this file into application repos.

Before any edit, read [`CONVENTIONS.md`](CONVENTIONS.md); before writing or changing a feature or a plugin, also read [`FEATURES.md`](FEATURES.md). Contributions are subject to [`AI_POLICY.md`](AI_POLICY.md).

Every rule holds unless explicitly overridden. Where a rule gives its reason, apply it to every case the reason covers, not only to the words.

## Size the change

Decide the size before the first edit, from the request and the code. The size sets how much process the change pays for.

A change is **small** when every line below holds, and **standard** otherwise:

- It edits one module (its files and their tests), or only `*.md` files.
- It adds or changes no public API: no export, option, default, signature, callback or type users write. A fix inside one that keeps its contract does not count.
- It creates, moves or renames no source file, except a test beside the module it tests.
- It touches nothing the `security-audit` row under Skills names.

| Step   | Small                                                                                                                                     | Standard                                                                     |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Plan   | A few lines in chat: the files, the test, the rule lines that decide it                                                                   | Load `plan-change` and write the plan it asks for                            |
| Checks | `CONVENTIONS.md` § Checks, for the scope of the change                                                                                    | The same                                                                     |
| Review | Read your own diff against the Rule map sections and the Working rules, and for anything left behind (debug output, a TODO, a stray file) | Run `review-change`: a sub-agent with a fresh context reviews the whole diff |
| Report | What changed, what you ran and its result                                                                                                 | The same, and what each review round found                                   |

- A small change that stops fitting a line above is standard from there: stop and plan before the next edit.
- When unsure, it is standard.
- A change to an agent doc or a skill runs `review-change` whatever its size: a wrong line there misleads every later session.

## Working rules

- **Look, then ask.** Ask only what neither the code nor these files answer: what the request leaves open, or why code you must change is built the way it is. Ask before the first edit when you can see the question then, otherwise as soon as it shows. Never guess a requirement. An option you offer states a choice, never a requirement the user did not give; recommend one. State any other assumption you went ahead on.
- **Minimum change.** Build what was asked and nothing beside it: no extra option, no abstraction for a single use, no refactor, reformat or comment fix in code the task does not need. Match the style around your change, and clean up only what your own change left behind. When a simpler approach than the one asked for exists, say so before you build.
- **Reuse first.** Before adding code, read the exports, callers and shared utilities around it. Before adding a type, a helper or a context object, use the one that exists, because two names for one concept split every caller. A new one states why none fits.
- **Facts from the code.** Take an API shape, a constraint or a design decision from the code and these files, never from the docs the project delivers (`docs/`, `<package>/docs/**`, a `README.md`, `ai/`): they may describe the code as it once was.
- **Legacy is not precedent.** Follow these files even where you disagree, and say so when you do. Code that contradicts them is legacy, even when it sits next to yours: do not copy it, because copying is how it spreads.
- **Conflicts.** Where two patterns contradict, follow these files; where they are silent, the more recent and better-tested one. Say which you followed and flag the other; never blend them. When a rule blocks what the task needs, stop and name the rule; do not work around it.
- **Two attempts.** After two failed attempts at the same failure, stop, say what you tried and ask. Never retry silently.
- **Report what is true.** "Done" means the checks ran and you saw them pass. Name every check, test or step you skipped and why: "tests pass" is wrong if any were skipped. A sub-agent's report is a claim until you have read its diff or the command output it returns.

## Use the cheapest thing that gets it right

Work goes to the first of these that does it right:

1. **A command**, when code can answer or produce it: count, search, check, convert, generate. A command's output is exact and can be rerun, and reasoning that imitates it is neither.
2. **A cheaper model**, in a sub-agent, where your tool lets you choose a sub-agent's model, for the work the table gives it.
3. **Your own model**, for everything else.

| Work                                                                                                                                             | Model                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| Find where something is, list callers, read a log, run the checks and report each command's exit status and what failed                          | the smallest your tool offers |
| Carry out the steps of a finished plan, edit docs only, rename across callers, apply one decided pattern to many files                           | a mid-tier one                |
| Size and plan a change, design a public API or a type, the work the `security-audit` row names, a bug of unknown cause, an agent doc, the review | yours, never a cheaper one    |

- Where two rows fit, the lower one wins.
- A cheaper model takes no design decision. Its brief says to stop and report where a step leaves one open; you decide, then send it back. One that fails twice at a step hands the step back to you.
- A sub-agent knows only its brief. Give it the goal, the exact files, the plan steps that are its own, the checks to run and what to return. One that edits files also gets the rule sections to read first: this file and the ones the Rule map names for its files. Tell it to take its facts from the code, not from the docs the project delivers.
- You stay the author. Read the diff a sub-agent returns before you build on it, and size, check and review the whole change as your own.
- Do not delegate what a few tool calls with short output finish: the brief costs more than the work. A search or a check run is delegated for the output it keeps out of your context.
- When you are a sub-agent handed a plan, carry it out as written, take no design decision it does not make, and stop and report where it leaves one open. Sizing, planning and `review-change` stay with the agent that started you.
- Where your tool cannot choose a sub-agent's model, end a standard plan by telling the user which steps a cheaper model can carry out, so they can switch for those and switch back for the review.

## Rule map

Before the first file of a kind below that you create or edit in a task, re-read its section, even if it is already in your context: a rule read at the start of a task fades by the time it applies.

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

[`.agents/skills/`](.agents/skills/README.md) holds skills for every agent (`.claude/skills` links to it). Load the one the table names before that work. Where a skill disagrees with these files, these files win: Vitest, not `node:test`; `.js` imports built with `tsc --build`, not type stripping; the package's check project, not `tsc --noEmit`; oxlint and oxfmt, not ESLint; checks run in the order of "Checks" in `CONVENTIONS.md`.

| Before you…                                                                                   | Load                     |
| --------------------------------------------------------------------------------------------- | ------------------------ |
| plan a standard change                                                                        | `plan-change`            |
| hand over a standard change or a change to an agent doc, or review a diff when asked          | `review-change`          |
| design or change a public API: an option, a default, a method, a callback, a type users write | `sharp-edges`            |
| write a generic, conditional or mapped type, or fight a type error                            | `typescript-magician`    |
| use a Node.js runtime API: streams, `process`, `node:*` modules, signals, workers             | `node`                   |
| write a Fastify plugin, hook or route                                                         | `fastify-best-practices` |
| touch authentication, cookies, CSRF, crypto or request parsing, or review for vulnerabilities | `security-audit`         |
| write a docs page or a README                                                                 | `documentation`          |
| change an agent doc, a skill or this table                                                    | `skill-optimizer`        |

`plan-change` and `review-change` are written here; the others are vendored. Do not edit a vendored skill. Record an unavoidable patch in [`.agents/skills/README.md`](.agents/skills/README.md). The skills shipped to applications live in [`ai/skills/`](ai/skills/), not here.

## Agent docs

- `CONVENTIONS.md`, `FEATURES.md`, this file and the skills written here change only when the maintainer explicitly asks for that change. A request to fix or build code is not one. When your work makes a rule wrong or shows one missing, stop and propose the exact wording; do not write it.
- They hold rules: what an agent would get wrong without being told. Not design descriptions, history, or what a lint, a type or a test already enforces.
- Agent rules live only in these files. Never add an `AGENTS.md` or a `CLAUDE.md` below the repository root: a package's rules go stale unseen. `ai/templates/` ships to applications and is exempt.
- A rule names a pattern, never a list of files or symbols that grows with the code.

## Git

- Never commit or push unless asked.
- Branch: `<type>/<topic>`, a Conventional Commits type and a kebab-case topic (`fix/cookie-max-age`). Never an AI tool or model name (`claude`, `codex`, `copilot`, `cursor`, `gemini`, …).
- Conventional Commits: `<type>(<optional scope>): <description>`. Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `build`, `ci`, `bench`. Description under 72 characters, imperative mood, no trailing period. A `!` before the colon marks a breaking change (`feat(http)!: …`): a pull request's title becomes the commit and its line in the release notes.
- No AI attribution in commits, pull requests, comments or reviews: no `Co-Authored-By` naming an assistant, no session link, no "Generated with" line. The contributor is the author of record.
- `make check` green before requesting review of a pull request; `make lint-markdown` when every changed file is `*.md`.
- Never use `git stash`. If uncommitted changes exist and you need to switch state, stop and ask.
- Never revert, discard, or `git checkout --` a file outside the current task's scope, including files a tool (`oxlint --fix`, `oxfmt`) modified as a side effect. That uncommitted state is other in-progress work: stop and report it.
- A branch your environment assigns that breaks the branch rule above (`claude/…`, `codex/…`) is replaced with a `<type>/<topic>` one: the maintainer's standing permission.

## Output

Chat in short, plain English. Lead with the answer. No filler.
Keep code names, paths, and error text exact. Do not simplify those.
