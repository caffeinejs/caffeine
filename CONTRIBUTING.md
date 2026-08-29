# Contributing

Agent instructions for this repository live in [`AGENTS.md`](AGENTS.md).

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
make test        # run tests
make testtypes   # run type checks
make lint        # check lint errors
make build       # compile
```

Run everything at once:

```sh
make all
```

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
- All checks must pass before requesting review (`make check`)
- Link to a related issue when one exists
