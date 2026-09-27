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
- Installed with `skills@1.7.0` from `…/skills/tree/<commit>`
- Local patches: none

| Skill                    | Upstream directory             | Why it is here                                                            |
| ------------------------ | ------------------------------ | ------------------------------------------------------------------------- |
| `fastify-best-practices` | `skills/fastify`               | `http`, `multipart` and `static` build on Fastify 5                       |
| `node`                   | `skills/node`                  | Streams, graceful shutdown, stuck and flaky tests, profiling              |
| `typescript-magician`    | `skills/typescript-magician`   | Generics and variance in the container and feature builders              |
| `documentation`          | `skills/documentation`         | Diátaxis structure for `ai/docs/`, READMEs and `docs/`                    |
| `skill-optimizer`        | `skills/skill-optimizer`       | Authoring and benchmarking the skills this project writes                 |

## Vendored from cloudflare/security-audit-skill

- Source: <https://github.com/cloudflare/security-audit-skill>
- Commit: `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` (2026-09-14)
- License: MIT, see [`LICENSE.cloudflare-security-audit-skill`](LICENSE.cloudflare-security-audit-skill)
- Installed with `skills@1.7.0` from `…/security-audit-skill/tree/<commit>/skills/security-audit`
- Local patches: none

| Skill            | Upstream directory      | Why it is here                                                                                               |
| ---------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `security-audit` | `skills/security-audit` | Focused security review of `http/security`, `caching` and other trust boundaries; full audit only when asked |

Start a review of `http/security` from [`http/security/SECURITY-REVIEW.md`](../../http/security/SECURITY-REVIEW.md).

## Vendored from trailofbits/skills

- Source: <https://github.com/trailofbits/skills>
- Commit: `0cc1c73a5e96749ab32d7ea5e14892fafa6972ae` (2026-09-24)
- License: CC BY-SA 4.0, see [`LICENSE.trailofbits-skills`](LICENSE.trailofbits-skills). The vendored files keep
  that license.
- Installed with `skills@1.7.0` from `…/skills/tree/<commit>/plugins/sharp-edges`
- Local patches: none

| Skill         | Upstream directory                       | Why it is here                                                                                            |
| ------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `sharp-edges` | `plugins/sharp-edges/skills/sharp-edges` | Misuse resistance of public APIs and options: security features, JWT and cookie settings, token lifetimes |

Only the skill directory is vendored. The plugin's `sharp-edges-analyzer` agent, which `SKILL.md` mentions, is not;
the skill runs without it.

## Adding a skill

Install with the `skills` CLI, never by copying files. Pin the CLI version and the source commit, target only the
`universal` agent (it writes `.agents/skills/`, which `.claude/skills` already links to), and copy rather than
symlink:

```sh
DISABLE_TELEMETRY=1 npx -y skills@1.7.0 add \
  https://github.com/<owner>/<repo>/tree/<commit>/<path-to-skill-or-plugin> \
  --skill <name> -a universal --copy -y
```

Then add a section with the source, commit, license file and a table row. `.gitignore` tracks everything in this
directory, and ignores the CLI's `skills-lock.json`. Keep personal or experimental skills at user level
(`~/.claude/skills/`, `~/.agents/skills/`), not here.

On Windows, clone with `core.symlinks=true`, or `.claude/skills` checks out as a plain file.
