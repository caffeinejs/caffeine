# Caffeine agent pack

User-facing files for coding agents that **write Caffeine apps**. Not contributor rules for this repository — those stay in the root [`AGENTS.md`](../AGENTS.md) and [`CONVENTIONS.md`](../CONVENTIONS.md).

| Path | Role |
|---|---|
| `llms.txt` | Index (llmstxt.org). Start here, then follow links. |
| `docs/` | Short how-tos. `rules.md` is the anti-hallucination list. |
| `templates/` | `AGENTS.md` / `CLAUDE.md` copied into new apps. |
| `skills/` | Workflows (Agent Skills). Copied to `.agents/skills/` on scaffold. |

Do not copy this repo’s root `CLAUDE.md` into an application.

## Scaffold

```bash
caffeine scaffold my-app
```

Writes `AGENTS.md`, `CLAUDE.md`, and `.agents/skills/` into the new app (managed block in `AGENTS.md` is the framework rules; put project notes below `<!-- END:caffeine-agent-rules -->`).

```bash
caffeine scaffold my-app --no-agents-md
```

Skips those files. Flavor template only.

Docs under `docs/` are **not** copied into the app. They stay in this tree (and later in the published packages).
