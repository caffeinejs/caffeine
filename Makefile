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
	@npm run pins:check
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

.PHONY: pincheck
pincheck: ## check that actions are pinned to a commit SHA and images to a digest
	@npm run pins:check

.PHONY: licensecheck
licensecheck: ## check production dependency licenses against the allowlist
	@npm run license:check

.PHONY: tools
tools: ## install external contributor tools
	@go install github.com/uwu-tools/scorecard-mcp/cmd/scorecard-mcp@v0.0.0-20260901030057-f95e5d8e4180

lint\:%: ## lint a single package and fix errors (e.g. lint:http)
	@npx oxlint --fix $*
	@npx oxfmt $*

# make matches a pattern with no slash against only the part of a goal after its last slash, so lint:% never matches a
# nested workspace such as lint:fetchy/fetchy. A pattern that names the parent directory is matched whole.
NESTED_WORKSPACE_PARENTS := integrations fetchy devtools di/examples examples plugins

define lint_nested
lint\:$(1)/%:
	@npx oxlint --fix $(1)/$$*
	@npx oxfmt $(1)/$$*
endef

$(foreach parent,$(NESTED_WORKSPACE_PARENTS),$(eval $(call lint_nested,$(parent))))

.PHONY: bench
bench: ## list available benchmarks
	@echo "Available benchmarks: helloworld startup memory request request:bun mixedscopes authn caching di di-compare di-compile di-perf fastify fetchy testing resilience aspect config-read config-reload"
	@echo "Usage: make bench:<type> (e.g. make bench:helloworld)"

bench\:%: ## build and run a benchmark (e.g. bench:helloworld)
	@npm run build
	@npm run build -w @caffeinejs/benchmarks
	@npm run bench:$* -w @caffeinejs/benchmarks

.PHONY: devtools
devtools:
	@npm run build
	@npm run dev -w @caffeinejs/devtools-ui

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
help:: ## show help
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@printf "\033[36m%-20s\033[0m %s\n" "build:<package>" "build a single package and its local deps (e.g. build:http)"
	@printf "\033[36m%-20s\033[0m %s\n" "build:cli" "build the caffeine CLI binary and link node_modules/.bin/caffeine"
	@printf "\033[36m%-20s\033[0m %s\n" "test:<package>" "run the test suite of a single package (e.g. test:http)"
	@printf "\033[36m%-20s\033[0m %s\n" "lint:<package>" "lint a single package and fix errors (e.g. lint:http)"
	@printf "\033[36m%-20s\033[0m %s\n" "lint-check:<package>" "lint a single package without fixing (e.g. lint-check:http)"
	@printf "\033[36m%-20s\033[0m %s\n" "fmt:<package>" "format a single package (e.g. fmt:http)"
	@printf "\033[36m%-20s\033[0m %s\n" "fmt-check:<package>" "check formatting of a single package (e.g. fmt-check:http)"
	@printf "\033[36m%-20s\033[0m %s\n" "bench:<type>" "build and run a benchmark (e.g. bench:helloworld)"

include examples/Makefile
