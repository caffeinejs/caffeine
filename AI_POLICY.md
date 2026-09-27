# AI policy

This policy covers what reaches this repository: issues, pull requests, commits, review comments, and security reports. Using an assistant locally is not the issue. Submitting the result is.

It applies to everyone, maintainers included, and to agents that open pull requests on someone's behalf. Agents working in this tree also follow [`AGENTS.md`](AGENTS.md) and [`CONVENTIONS.md`](CONVENTIONS.md). This file is the human gate.

## Accountability

Every contribution has a human author of record. That person has read the whole diff, can explain every line, and answers review questions without going back to the assistant. “The agent wrote it” is not a defense.

The MIT license grant, including for AI-assisted parts, is theirs. Do not submit code, tests, or docs copied from another project unless its license allows it and the source is named in the pull request.

## Disclosure

A pull request needs this block when an assistant wrote any part of the diff, the description, or the tests:

```md
## AI assistance

- Tool:
- Scope:
- Reviewer: I, @<github-login>, have read and understand every line in this pull request.
```

- `Tool` is the product and model, as precisely as the tool reports it.
- `Scope` names what the assistant produced: the whole change, tests only, docs only, or named files. `Scope: none of the diff` is valid when it only helped you read the code.
- Inline completion of a single line, spelling fixes, and search do not need the block.

Commits may carry a `Co-authored-by:` trailer for the assistant. It does not replace the block.

## Agent-opened pull requests

An agent may open a pull request only for a named human who asked for the change. That person is the author of record, is named in the pull request body, and fills in the `Reviewer` line after reading the diff.

- The pull request stays a draft until the named human has reviewed it.
- The agent drives CI and review threads on it; a human decides whether it merges.
- An approval from a review bot or an agent never counts as the human review a merge needs.
- Agents do not open issues, comment on other people's pull requests, or answer reviewers outside the pull request they were asked to drive.

## What assistants get wrong here

These are the failures reviewers look for first. Each one blocks a merge.

- **Tests weakened to pass.** No skipped, deleted, or loosened tests, snapshots, or assertions to get CI green. A test that changes must say why in the pull request.
- **Invented dependencies.** Check that every new package exists on npm, is the one you meant, and is maintained. Say why it is needed. The root `.npmrc` sets `ignore-scripts=true`; do not work around it.
- **Hand-edited generated files.** `package-lock.json` and `dist/` come from their tools, never from a model.
- **Silenced checks.** No new `oxlint` disables, `@ts-expect-error`, or `any` to quiet the build without a comment saying why.
- **Supply chain drift.** Workflow permissions, pinned action SHAs, and pinned image digests do not change unless that is the point of the pull request.
- **Borrowed patterns.** This is not NestJS, Express, or Spring. Legacy decorators, `reflect-metadata`, and Nest-style modules are rejected ([`CONVENTIONS.md`](CONVENTIONS.md)).
- **Scope creep.** Unrequested refactors, reformatting, or rewritten comments next to the change. Keep the diff to what the pull request says it does.

## Issues and security reports

Reproduce a bug before filing it and include the reproduction. A report you did not verify, or a summary an assistant wrote about code it did not run, will be closed.

Report vulnerabilities privately, not in a public issue. An AI-generated vulnerability report without a working proof of concept against this repository is closed without triage.

## Data you give to assistants

Do not paste secrets, tokens, private keys, or anyone's personal data into a prompt. Analysis servers in [`.mcp.json`](.mcp.json) read tokens from your environment; use your own user token, never a CI secret ([`docs/internal/analysis-mcp.md`](docs/internal/analysis-mcp.md)).

Keep personal agent configuration out of the diff: local MCP copies, editor rules, and `settings.local` files stay git-ignored.

## Enforcement

Maintainers may close a pull request or issue that breaks this policy, or ask for a resubmit, without a line-by-line review. Rejected without debate:

- Unreviewed dumps, including large diffs the author cannot explain
- Missing or false disclosure
- Secrets in the diff
- Code the contributor has no right to license

Repeated violations may lead to a block from the repository.
