# Contributor agent instructions

Rules for changing **this** monorepo. User-app and framework-usage agent files live in [`ai/`](ai/). Do not copy this file into application repos.

Before any edit, read [`CONVENTIONS.md`](CONVENTIONS.md). When editing a first-party package, also read that package’s `AGENTS.md` (table in `CONVENTIONS.md`). Contributions are subject to [`AI_POLICY.md`](AI_POLICY.md).

These rules apply to every task unless explicitly overridden.
Bias: caution over speed on non-trivial work. Use judgment on trivial tasks.

## Output

Chat in short, plain English. Lead with the answer. No filler.
Keep code names, paths, and error text exact. Do not simplify those.

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

## Analysis MCP

[`.mcp.json`](.mcp.json) is the base server list. Copy it when a client needs its own file, and change only that client's env syntax.

Claude Code loads `.mcp.json` directly and expands `${CAFFEINE_SONARQUBE_TOKEN}`. Cursor loads [`.cursor/mcp.json`](.cursor/mcp.json), the same list with `${env:CAFFEINE_SONARQUBE_TOKEN}`. Cursor launches `scorecard-mcp` from `${userHome}/go/bin`, the default `go install` location, because the app does not inherit the shell `PATH`.

Export `CAFFEINE_SONARQUBE_TOKEN` to a SonarQube Cloud user token (My Account → Security) in the environment that launches the client. A shell profile is not visible to a desktop-launched app. Do not reuse the GitHub Actions analysis secret `SONAR_TOKEN`.

If `scorecard-mcp` is not on `PATH`, run `make tools`. `go install` writes to `$(go env GOPATH)/bin`, which must be on the `PATH` of the process that launches the client.

### SonarQube Cloud

Project key `caffeinejs_caffeine`, org `caffeinejs`. Query the files in the change, or set `pullRequest` to the GitHub PR number. Do not load the full issue list. Do not change issue status.

The Free plan only has `main` and pull requests whose target is `main`. Version-branch scans do not become separate branches.

If the server is not connected, use `https://sonarcloud.io/api/issues/search?componentKeys=caffeinejs_caffeine`.

`qualitygates/project_status` currently returns `NONE` even though the project is on Sonar way. Do not treat that as pass or fail. Use issue search.

### OpenSSF Scorecard

Repository argument is `github.com/caffeinejs/caffeine`. Use `get_repo_score` or `get_check_result` for this repo. Use `explain_check` for what a failing check means. Do not treat the aggregate score as a security verdict.

A check score of `-1` is inconclusive, not a failure. The public cache omits `CI-Tests`, `Contributors`, and `Dependency-Update-Tool`. This repo opts in via `publish_results: true`, so the other checks are present.

If the server is not connected, use `https://api.scorecard.dev/projects/github.com/caffeinejs/caffeine`.
