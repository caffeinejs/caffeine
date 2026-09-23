# Analysis MCP

Setting up and reading the analysis MCP servers. Rare enough to stay out of every agent turn.

[`.mcp.json`](../../.mcp.json) is the base server list, and the only one in the repository. A client that needs its own file gets a **local, git-ignored** copy — change only that client's env syntax.

Claude Code loads `.mcp.json` directly and expands `${CAFFEINE_SONARQUBE_TOKEN}`. Cursor reads `.cursor/mcp.json`, which `.gitignore` excludes: copy `.mcp.json` there yourself, write the token as `${env:CAFFEINE_SONARQUBE_TOKEN}`, and point `scorecard-mcp` at `${userHome}/go/bin/scorecard-mcp` — the default `go install` location, needed because the app does not inherit the shell `PATH`.

Export `CAFFEINE_SONARQUBE_TOKEN` to a SonarQube Cloud user token (My Account → Security) in the environment that launches the client. A shell profile is not visible to a desktop-launched app. Do not reuse the GitHub Actions analysis secret `SONAR_TOKEN`.

If `scorecard-mcp` is not on `PATH`, run `make tools`. `go install` writes to `$(go env GOPATH)/bin`, which must be on the `PATH` of the process that launches the client.

## SonarQube Cloud

Project key `caffeinejs_caffeine`, org `caffeinejs`. Query the files in the change, or set `pullRequest` to the GitHub PR number. Do not load the full issue list. Do not change issue status.

The Free plan only has `main` and pull requests whose target is `main`. Version-branch scans do not become separate branches.

If the server is not connected, use `https://sonarcloud.io/api/issues/search?componentKeys=caffeinejs_caffeine`.

`qualitygates/project_status` currently returns `NONE` even though the project is on Sonar way. Do not treat that as pass or fail. Use issue search.

## OpenSSF Scorecard

Repository argument is `github.com/caffeinejs/caffeine`. Use `get_repo_score` or `get_check_result` for this repo. Use `explain_check` for what a failing check means. Do not treat the aggregate score as a security verdict.

A check score of `-1` is inconclusive, not a failure. The public cache omits `CI-Tests`, `Contributors`, and `Dependency-Update-Tool`. This repo opts in via `publish_results: true`, so the other checks are present.

If the server is not connected, use `https://api.scorecard.dev/projects/github.com/caffeinejs/caffeine`.
