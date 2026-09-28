# The example targets that run a server start it with its own command rather than `npm start` or `npx`: Ctrl+C
# reaches every process in the terminal's group, npm forwards it a second time, and a second signal is an order to
# exit at once, so the application's graceful shutdown never runs.

.PHONY: examples-readme
examples-readme: ## generate the examples README table of contents
	@node tools/generate-examples-readme.mjs

.PHONY: example\:devtools
example\:devtools:
	@npm run build
	@node_modules/.bin/tsx examples/02-devtools-basic/index.ts

.PHONY: example\:petstore
# A target-specific export, not a recipe line: make 3.81 (the macOS system make) ignores .ONESHELL, so an
# `export` written in the recipe dies with the line's own shell and never reaches npm.
example\:petstore: export DATABASE_URL ?= postgresql://petstore:petstore@localhost:5432/petstore?schema=public
# Not a prerequisite: make 3.81 keeps the backslash in a prerequisite name, so `build\:cli` there names a target
# that does not exist and the CLI is never built; `$(MAKE)` resolves the name the way the command line does.
example\:petstore: ## run the petstore example (Postgres in Docker, app on host at http://localhost:9999)
	@$(MAKE) build:cli
	@docker compose -f examples/03-petstore/docker-compose.yml up -d postgres

	@echo "waiting for postgres ..."
	@until docker compose -f examples/03-petstore/docker-compose.yml exec -T postgres pg_isready -U petstore -d petstore >/dev/null 2>&1; do sleep 1; done
	@npm run build
	@npm run build -w @caffeinejs/example-petstore
	@npm run db:migrate -w @caffeinejs/example-petstore
	@npm run db:seed -w @caffeinejs/example-petstore
	@cd examples/03-petstore && ../../node_modules/.bin/tsx src/main.ts

.PHONY: example\:spa-dashboard
# Not a prerequisite: make 3.81 keeps the backslash in a prerequisite name, so `build\:cli` there names a target
# that does not exist and the CLI is never built; `$(MAKE)` resolves the name the way the command line does.
example\:spa-dashboard: ## run the SPA dashboard example (app on host at http://127.0.0.1:9010)
	@$(MAKE) build:cli
	@npm run build
	@npm run build -w @caffeinejs/example-spa-dashboard
	@cd examples/04-spa-dashboard && ../../node_modules/.bin/tsx api/main.ts

.PHONY: example\:watt
example\:watt: ## run the Watt example (entrypoint at http://127.0.0.1:3042/shop, probes at http://127.0.0.1:9090)
	@npm run build
	@npm run build -w @caffeinejs/example-watt
	@node_modules/.bin/wattpm start examples/05-watt

help::
	@printf "\033[36m%-20s\033[0m %s\n" "example:petstore" "run the petstore example (Postgres in Docker, app on host at http://localhost:9999)"
	@printf "\033[36m%-20s\033[0m %s\n" "example:spa-dashboard" "run the SPA dashboard example (app on host at http://127.0.0.1:9010)"
	@printf "\033[36m%-20s\033[0m %s\n" "example:watt" "run the Watt example (entrypoint at http://127.0.0.1:3042/shop, probes at http://127.0.0.1:9090)"
