.ONESHELL:
.DEFAULT_GOAL := help

CLI_SRCS := $(shell find cli -name '*.ts' ! -path '*/dist/*' ! -name '*.test.ts' ! -path '*/templates/*')

-include Makefile.overrides # allow user specific optional overrides
-include .env # allow user specific optional environment variables

export

.PHONY: build
build: ## build all packages
	@npm run build:force

.PHONY: build\:cli
build\:cli: ## build the caffeine CLI binary and link node_modules/.bin/caffeine
	@npm run build:cli

cli/dist/caffeine: $(CLI_SRCS) cli/package.json
	@npm run build:cli

build\:%: ## build a single package and its local deps (e.g. build:http)
	@npm run build -w $*

.PHONY: clean
clean: ## remove build artifacts
	@npm run clean

.PHONY: test
test: ## run all tests
	@npm test

test\:%: ## run the test suite of a single package (e.g. test:http)
	@npm test -w $*

.PHONY: check
check: ## run all checks
	@npm run lint:fix
	@npm run lint:markdown
	@npm run build
	@$(MAKE) cli/dist/caffeine
	@npm run build:examples
	@npm run test:typecheck
	@npm run test:memory
	@npm test

.PHONY: fmt
fmt: ## format code
	@npm run fmt

fmt\:%: ## format a single package (e.g. fmt:http)
	@npx oxfmt $*

.PHONY: lint
lint: ## check lint and fix errors
	@npm run lint:fix

.PHONY: lint-markdown
lint-markdown: ## lint markdown
	@npm run lint:markdown

.PHONY: licensecheck
licensecheck: ## check production dependency licenses against the allowlist
	@npm run license:check

lint\:%: ## lint a single package and fix errors (e.g. lint:http)
	@npx oxlint --fix $*
	@npx oxfmt $*

.PHONY: bench
bench: ## list available benchmarks
	@echo "Available benchmarks: helloworld startup memory request request:bun mixedscopes authn caching di di-compare di-compile di-perf fastify testing resilience aspect config-read config-reload"
	@echo "Usage: make bench:<type> (e.g. make bench:helloworld)"
	@echo "Fetchy HTTP client benchmark: make bench-fetchy"

bench\:%: ## build and run a benchmark (e.g. bench:helloworld)
	@npm run build
	@npm run build -w @caffeinejs/benchmarks
	@npm run bench:$* -w @caffeinejs/benchmarks

.PHONY: bench-fetchy
bench-fetchy: ## run fetchy HTTP client benchmarks (vs fetch/axios/got/undici)
	@npm run bench -w @caffeinejs/fetchy

.PHONY: devtools
devtools:
	@npm run build
	@npm run dev -w @caffeinejs/devtools-ui

.PHONY: example\:devtools
example\:devtools:
	@npm run build
	@npx tsx examples/02-devtools-basic/index.ts

.PHONY: example\:petstore
# A target-specific export, not a recipe line: make 3.81 (the macOS system make) ignores .ONESHELL, so an
# `export` written in the recipe dies with the line's own shell and never reaches npm.
example\:petstore: export DATABASE_URL ?= postgresql://petstore:petstore@localhost:5432/petstore?schema=public
example\:petstore: build\:cli ## run the petstore example (Postgres in Docker, app on host at http://localhost:9999)
	@docker compose -f examples/03-petstore/docker-compose.yml up -d postgres
	@echo "waiting for postgres ..."
	@until docker compose -f examples/03-petstore/docker-compose.yml exec -T postgres pg_isready -U petstore -d petstore >/dev/null 2>&1; do sleep 1; done
	@npm run build
	@npm run build -w @caffeinejs/example-petstore
	@npm run db:migrate -w @caffeinejs/example-petstore
	@npm run db:seed -w @caffeinejs/example-petstore
	@npm start -w @caffeinejs/example-petstore

# .
# End-to-End Toolchain
# End-to-End tests specific helper tasks
# .

.PHONY: configserver-up
configserver-up: ## spin up the Spring Cloud Config Server locally (Docker)
	@docker compose -f test/services/configserver/docker-compose.yml up --build -d
	@echo "waiting for http://localhost:8888/actuator/health ..."
	@until wget -qO- http://localhost:8888/actuator/health >/dev/null 2>&1; do sleep 2; done
	@echo "configserver is up"

.PHONY: configserver-down
configserver-down: ## stop the Spring Cloud Config Server
	@docker compose -f test/services/configserver/docker-compose.yml down

.PHONY: oauthserver-up
oauthserver-up: ## spin up the Spring Authorization Server locally (Docker)
	@docker compose -f test/services/oauthserver/docker-compose.yml up --build -d
	@echo "waiting for http://localhost:9000/actuator/health ..."
	@until wget -qO- http://localhost:9000/actuator/health >/dev/null 2>&1; do sleep 2; done
	@echo "oauthserver is up"

.PHONY: oauthserver-down
oauthserver-down: ## stop the Spring Authorization Server
	@docker compose -f test/services/oauthserver/docker-compose.yml down

.PHONY: redis-up
redis-up: ## spin up Redis and Valkey locally, standalone and one-node clusters (Docker)
	@docker compose -f test/services/redis/docker-compose.yml up -d --wait
	@echo "redis and valkey are up, standalone (6379, 6380) and cluster (6381, 6382)"

.PHONY: redis-down
redis-down: ## stop Redis and Valkey
	@docker compose -f test/services/redis/docker-compose.yml down

.PHONY: test-e2e
test-e2e: oauthserver-up configserver-up redis-up ## run the e2e against a real Spring Authorization Server, Config Server, Redis and Valkey
	@npm run test:e2e; status=$$?; \
		docker compose -f test/services/oauthserver/docker-compose.yml down; \
		docker compose -f test/services/configserver/docker-compose.yml down; \
		docker compose -f test/services/redis/docker-compose.yml down; \
		exit $$status

.PHONY: kafka-up
kafka-up: ## spin up a single-node Kafka broker locally (Docker)
	@docker compose -f kafka/docker-compose.yml up -d
	@echo "waiting for kafka on localhost:9092 ..."
	@until docker compose -f kafka/docker-compose.yml exec -T kafka /opt/kafka/bin/kafka-broker-api-versions.sh --bootstrap-server localhost:9092 >/dev/null 2>&1; do sleep 2; done
	@echo "kafka is up"

.PHONY: kafka-down
kafka-down: ## stop the local Kafka broker
	@docker compose -f kafka/docker-compose.yml down

.PHONY: test-kafka
test-kafka: kafka-up ## run the kafka integration tests against a real broker
	@npx vitest run --project kafka; status=$$?; docker compose -f kafka/docker-compose.yml down; exit $$status

# .
# Miscellaneous
# General purpose tasks
# .

.PHONY: status
status: ## print GitHub CI status for the current branch
	@command -v gh >/dev/null 2>&1 || { echo "Cannot find gh: install GitHub CLI (https://cli.github.com)"; exit 1; }
	@gh auth status -h github.com >/dev/null 2>&1 || { echo "Cannot use gh: run gh auth login"; exit 1; }
	@branch=$$(git branch --show-current); \
	repo=$$(gh repo view --json nameWithOwner -q .nameWithOwner); \
	echo "CI status for branch $$branch ($$repo)"; \
	echo; \
	if gh pr view "$$branch" --json number -q .number >/dev/null 2>&1; then \
	  echo "Pull request checks:"; \
	  gh pr checks || true; \
	  echo; \
	fi; \
	echo "Workflow runs (CI):"; \
	gh run list --workflow=ci.yml --branch "$$branch" --limit 5; \
	run_id=$$(gh run list --workflow=ci.yml --branch "$$branch" --limit 1 --json databaseId -q '.[0].databaseId'); \
	if [ -n "$$run_id" ] && [ "$$run_id" != "null" ]; then \
	  echo; \
	  echo "Latest run jobs:"; \
	  gh run view "$$run_id" --json jobs -q '.jobs[] | "\(.name)\t\(.status)\t\(.conclusion // "-")"'; \
	fi

.PHONY: help
help: ## show help
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@printf "\033[36m%-20s\033[0m %s\n" "build:<package>" "build a single package and its local deps (e.g. build:http)"
	@printf "\033[36m%-20s\033[0m %s\n" "build:cli" "build the caffeine CLI binary and link node_modules/.bin/caffeine"
	@printf "\033[36m%-20s\033[0m %s\n" "test:<package>" "run the test suite of a single package (e.g. test:http)"
	@printf "\033[36m%-20s\033[0m %s\n" "lint:<package>" "lint a single package and fix errors (e.g. lint:http)"
	@printf "\033[36m%-20s\033[0m %s\n" "lint-check:<package>" "lint a single package without fixing (e.g. lint-check:http)"
	@printf "\033[36m%-20s\033[0m %s\n" "fmt:<package>" "format a single package (e.g. fmt:http)"
	@printf "\033[36m%-20s\033[0m %s\n" "fmt-check:<package>" "check formatting of a single package (e.g. fmt-check:http)"
	@printf "\033[36m%-20s\033[0m %s\n" "bench:<type>" "build and run a benchmark (e.g. bench:helloworld)"
	@printf "\033[36m%-20s\033[0m %s\n" "example:petstore" "run the petstore example (Postgres in Docker, app on host at http://localhost:9999)"
