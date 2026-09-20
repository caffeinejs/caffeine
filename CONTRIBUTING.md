# Contributing

- Agent behavior: [`AGENTS.md`](AGENTS.md)
- Coding conventions: [`CONVENTIONS.md`](CONVENTIONS.md)
- AI-assisted contributions: [`AI_POLICY.md`](AI_POLICY.md)

## Prerequisites

- Node.js >= 20
- npm >= 10

## Setup

```sh
git clone https://github.com/caffeinejs/caffeine.git
cd caffeine
npm install
```

## Running checks

```sh
make test           # run tests
make lint           # oxlint + oxfmt, with fixes
make lint-markdown  # markdownlint (docs-only changes)
make build          # compile
make check          # full quality gate
```

Docs-only changes (`*.md` and nothing else) need `make lint-markdown`, not `make check`.

End-to-end tests are not part of `make check`. `make test-e2e` needs Docker: it starts the services under
`test/services/`, runs `test/e2e/`, and stops them. A spec whose service is down skips. CI runs the `E2E` job
with `CAFFEINE_E2E_STRICT=1`, which fails such a spec instead. The OIDC and OAuth2 specs are not part of the
CI run yet.

## Commit conventions

Commits must follow [Conventional Commits](https://www.conventionalcommits.org/).

```
<type>(<optional scope>): <description>
```

Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `perf`.

Examples:

```
feat(scopes): add transient scope support
fix(container): resolve circular dependency detection bug
docs: update getting started guide
```

Keep the description short (under 72 characters), imperative mood, no trailing period.

## Pull requests

- Keep PRs focused — one concern per PR
- Add or update tests for any changed behaviour
- All checks must pass before requesting review (`make check`, or `make lint-markdown` when every changed file is `*.md`)
- AI-assisted PRs must follow [`AI_POLICY.md`](AI_POLICY.md) (human review and the disclosure block)
- Link to a related issue when one exists
