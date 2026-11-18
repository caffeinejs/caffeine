# Set up agent coordination

This guide sets up which AI tools and models work on your changes to this repository. [`AGENTS.md`](../AGENTS.md)
defines the roles: the model tiers under "Use the cheapest thing that gets it right", and the reviewers that
`review-change` starts. Contributors have different tools, so each one fills those roles in a file git ignores, under
an `Agent coordination` heading. Without that heading, your agent picks the models itself and starts no extra reviewer.

## Before you start

- Find your agent's personal instruction file. In Claude Code it is `CLAUDE.local.md` at the repository root, which
  `.gitignore` already lists. For another tool, use its own personal file, and add it to the file
  `git rev-parse --git-path info/exclude` prints when `.gitignore` does not list it.
- In Codex, keep the setup out of `AGENTS.override.md`: Codex reads that file instead of the repository's `AGENTS.md`.
  Put it in a git-ignored file in this repository, and have your global `~/.codex/AGENTS.md` name that file for this
  repository only.
- Install every tool you want as an extra reviewer, sign in, and put it on your `PATH`.
- Allow your agent to run each extra reviewer's command without a permission prompt, and outside its own sandbox when
  the reviewer needs the network or a sandbox of its own, as Codex does.

## Set it up

1. Copy the template below into your personal instruction file.
2. Fill `### Models`: for each tier, a model your tool offers, its effort (`—` keeps the tool's default), and
   the sub-agent type where the tool has them.
3. Fill `### Extra reviewers`, or delete that part to keep only your tool's own reviewer. Each command must run the
   reviewer read-only and without prompts, read the review prompt from `<prompt file>`, and write its report to
   `<report file>`. Keep `<model>`, `<effort>`, `<prompt file>` and `<report file>` in the command, quoted where a
   path goes: the agent fills them when it runs it. Fill the row's Model and Effort: `—` would reach the command as
   it is.
4. Make a change of your own and ask your agent to hand it over through `review-change`. Check that its report names
   every reviewer with its findings.

## Template

```md
## Agent coordination

### Models

| Tier     | Model | Effort | Sub-agent type |
| -------- | ----- | ------ | -------------- |
| smallest |       |        |                |
| mid-tier |       |        |                |
| yours    |       |        |                |

### Extra reviewers

| Reviewer | Command | Model | Effort |
| -------- | ------- | ----- | ------ |
|          |         |       |        |
```

## Example: Claude Code with a Codex reviewer

```md
## Agent coordination

### Models

| Tier     | Model        | Effort | Sub-agent type                                                  |
| -------- | ------------ | ------ | --------------------------------------------------------------- |
| smallest | `haiku`      | —      | `Explore` to find and read, `general-purpose` to run the checks |
| mid-tier | `sonnet`     | —      | `general-purpose`                                               |
| yours    | omit `model` | —      | `general-purpose`                                               |

### Extra reviewers

| Reviewer | Command                                                                                                        | Model           | Effort  |
| -------- | -------------------------------------------------------------------------------------------------------------- | --------------- | ------- |
| Codex    | `codex exec -s read-only -m <model> -c model_reasoning_effort=<effort> -o "<report file>" - < "<prompt file>"` | `gpt-6.2-astra` | `xhigh` |
```

- `-s read-only` sandboxes the shell commands Codex runs, not its MCP servers: turn off any MCP server that can write
  before you use Codex as a reviewer. `-m` and `-c` override `~/.codex/config.toml`, so the row is the one place to
  change the model and effort.
- In Claude Code, write the prompt file and the report file in the session's scratchpad directory, a new report file
  for each round, and run the command with Bash `run_in_background: true`: an `xhigh` review outlasts the 10-minute
  limit of a foreground command. Read the report file when the command exits.
- Codex reads `.agents/skills/`, so it loads `review-change` by name.
