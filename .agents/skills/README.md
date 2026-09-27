# Contributor skills

Agent Skills for people working on **this** monorepo. Cursor, Codex, Copilot and Gemini read this directory directly.
Claude Code reads `.claude/skills`, which is a symlink to it.

These are not the skills shipped to applications. Those live in [`ai/skills/`](../../ai/skills/) and are copied into
apps by `caffeine scaffold`.

Where a skill here conflicts with [`CONVENTIONS.md`](../../CONVENTIONS.md) or a package `AGENTS.md`, the repository
wins. See "Third-party skills" in [`AGENTS.md`](../../AGENTS.md).

## Vendored from mcollina/skills

- Source: <https://github.com/mcollina/skills>
- Commit: `856efd268ae85482d882f3d0bed869fd020b5c06` (2026-08-17)
- License: MIT, see [`LICENSE.mcollina-skills`](LICENSE.mcollina-skills)
- Local patches: `init` is renamed to `agents-md` (directory and `name:` only), because Claude Code's built-in `/init`
  hides a project skill named `init`

| Skill                    | Upstream directory             | Why it is here                                                            |
| ------------------------ | ------------------------------ | ------------------------------------------------------------------------- |
| `fastify-best-practices` | `skills/fastify`               | `http`, `multipart` and `static` build on Fastify 5                       |
| `node`                   | `skills/node`                  | Streams, graceful shutdown, stuck and flaky tests, profiling              |
| `typescript-magician`    | `skills/typescript-magician`   | Generics and variance in the container and feature builders              |
| `documentation`          | `skills/documentation`         | Diátaxis structure for `ai/docs/`, READMEs and `docs/`                    |
| `agents-md`              | `skills/init`                  | Keeping the `AGENTS.md` files short and accurate                          |
| `skill-optimizer`        | `skills/skill-optimizer`       | Authoring and benchmarking the skills this project writes                 |

Each directory is copied from upstream unchanged, except for the patch above. `skills/fastify` is copied to
`fastify-best-practices`, because a skill's directory must match its `name`.

## Adding a skill

Add its directory here and a row to the table. `.gitignore` tracks everything in this directory, so nothing else needs
changing. Keep personal or experimental skills at user level (`~/.claude/skills/`, `~/.agents/skills/`), not here.

On Windows, clone with `core.symlinks=true`, or `.claude/skills` checks out as a plain file.
