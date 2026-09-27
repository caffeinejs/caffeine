# Analysis MCP

Setting up and reading the analysis MCP servers. Rare enough to stay out of every agent turn.

[`.mcp.json`](../../.mcp.json) is the base server list, and the only one in the repository. A client that needs its own file gets a **local, git-ignored** copy — change only that client's env syntax.

Claude Code loads `.mcp.json` directly and expands `${VAR}`. Cursor reads `.cursor/mcp.json`, which `.gitignore` excludes. Copy `.mcp.json` there yourself and write each token as `${env:VAR}`. Point `scorecard-mcp` at `${userHome}/go/bin/scorecard-mcp` — the default `go install` location, needed because the app does not inherit the shell `PATH`. Do not replace that file with `.mcp.json`: the Scorecard path and the `${env:VAR}` tokens would be lost.

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

## GitHub

Repository is `github.com/caffeinejs/caffeine`. The server is read-only (`X-MCP-Readonly: true`). Toolsets are `context`, `issues`, `pull_requests`, `actions`, `code_security`, `dependabot`, and `secret_protection`.

Use it for Actions logs (`test`, `sonar`, `e2e`, plus license, docs, bench, and Scorecard), review threads, code scanning, Dependabot alerts, and secret scanning. Open or merge a pull request with `gh`. SonarQube stays the quality gate. Scorecard stays the public aggregate. Alerts are signals, not a verdict.

Export `CAFFEINE_GITHUB_MCP_TOKEN` in the environment that launches the client. Claude expands `${CAFFEINE_GITHUB_MCP_TOKEN}`. Cursor's copy uses `${env:CAFFEINE_GITHUB_MCP_TOKEN}`. A shell profile is not visible to a desktop-launched app. Do not commit the token. Do not reuse `SONAR_TOKEN` or `GITHUB_TOKEN`.

Fine-grained personal access token only, this repository only, no organization permissions. Set these repository permissions to Read-only. Every other repository permission stays No access. Access is never Read and write.

- **Metadata** (`metadata`) — forced on by GitHub. Repository name and visibility only.
- **Actions** (`actions`) — workflow runs, jobs, and logs.
- **Contents** (`contents`) — pull request file list and patch. Does not allow push. The `repos` and `git` toolsets stay disabled.
- **Issues** (`issues`).
- **Pull requests** (`pull_requests`) — the pull request, reviews, and review threads.
- **Code scanning alerts** (`security_events`) — CodeQL and the Scorecard SARIF upload. Not Code quality.
- **Dependabot alerts** (`vulnerability_alerts`). Not Dependabot secrets.
- **Secret scanning alerts** (`secret_scanning_alerts`). Not Secrets.

Leave **Workflows**, **Secrets**, **Variables**, **Dependabot secrets**, **Administration**, **Repository security advisories**, **Commit statuses**, **Deployments**, **Environments**, **Pages**, **Webhooks**, **Artifact metadata**, and **Attestations** at No access.

The account that owns the token must already be allowed to see code scanning, Dependabot, and secret scanning alerts. Read-only on the token does not grant that. If those calls return unauthorized, change the account's role on the repo. Do not add write permissions or extra toolsets.

## Context7

Remote server `https://mcp.context7.com/mcp`. The header is `Authorization: Bearer`.

Export `CAFFEINE_CONTEXT7_MCP_API_KEY` in the environment that launches the client. Claude expands `${CAFFEINE_CONTEXT7_MCP_API_KEY}`. Cursor's copy uses `${env:CAFFEINE_CONTEXT7_MCP_API_KEY}`. A shell profile is not visible to a desktop-launched app. Do not commit the key. Do not reuse `CAFFEINE_SONARQUBE_TOKEN` or `CAFFEINE_GITHUB_MCP_TOKEN`.
