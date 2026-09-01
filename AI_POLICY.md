# AI policy

This policy applies to contributions to this repository: issues, pull requests, and commits. Using an assistant locally is not the issue. Submitting the result is.

Agents working in this tree follow [`AGENTS.md`](AGENTS.md) and [`CONVENTIONS.md`](CONVENTIONS.md). This file is the human gate.

## Allowed

Assistants may be used for code, tests, review, and documentation. The quality bar is the same as hand-written work: [`CONVENTIONS.md`](CONVENTIONS.md), tests where behavior changes, and CI.

## Required human review

A human must read the diff and be able to explain every line they submit. “The agent wrote it” is not a defense.

The contributor is the author of record. The MIT license grant, including for AI-assisted parts, is theirs.

## Required pull request disclosure

Every pull request that used an assistant must include this block:

```
## AI assistance
- Tool:
- Scope:
- Reviewer: I have read and understand every line in this pull request.
```

`Scope` is what the assistant authored (the whole change, tests only, docs only, named files). Without the block, maintainers may close the pull request or ask for a resubmit.

## Rejected without debate

- Unreviewed dumps
- Secrets in prompts or in the diff
- Copyrighted material the contributor cannot grant
