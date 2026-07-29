.ONESHELL:
.DEFAULT_GOAL := help

-include Makefile.overrides # allow user specific optional overrides
-include .env # allow user specific optional environment variables

export

.PHONY: build
build: ## build all packages
	@npm run build:force

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
	@npm run test:typecheck
	@npm run test:typecheck:benchmarks
	@npm run test:memory
	@npm test

.PHONY: fmt
fmt: ## format code
	@npm run fmt

fmt\:%: ## format a single package (e.g. fmt:http)
	@npm run fmt -w $*

.PHONY: lint
lint: ## check lint and fix errors
	@npm run lint:fix

lint\:%: ## lint a single package and fix errors (e.g. lint:http)
	@npm run lint:fix -w $*

.PHONY: bench
bench: ## list available benchmarks
	@echo "Available benchmarks: helloworld startup request request:bun mixedscopes"
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

# Config Server (test infrastructure)
# --

.PHONY: configserver-up
configserver-up: ## spin up the Spring Cloud Config Server locally (Docker)
	@docker compose -f test/services/configserver/docker-compose.yml up --build

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

.PHONY: test-e2e
test-e2e: oauthserver-up ## run the OIDC/OAuth2 e2e against a real Spring Authorization Server
	@npm run test:e2e; status=$$?; docker compose -f test/services/oauthserver/docker-compose.yml down; exit $$status

# Misc
# --

.PHONY: help
help: ## show help
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@printf "\033[36m%-20s\033[0m %s\n" "build:<package>" "build a single package and its local deps (e.g. build:http)"
	@printf "\033[36m%-20s\033[0m %s\n" "test:<package>" "run the test suite of a single package (e.g. test:http)"
	@printf "\033[36m%-20s\033[0m %s\n" "lint:<package>" "lint a single package and fix errors (e.g. lint:http)"
	@printf "\033[36m%-20s\033[0m %s\n" "lint-check:<package>" "lint a single package without fixing (e.g. lint-check:http)"
	@printf "\033[36m%-20s\033[0m %s\n" "fmt:<package>" "format a single package (e.g. fmt:http)"
	@printf "\033[36m%-20s\033[0m %s\n" "fmt-check:<package>" "check formatting of a single package (e.g. fmt-check:http)"
	@printf "\033[36m%-20s\033[0m %s\n" "bench:<type>" "build and run a benchmark (e.g. bench:helloworld)"
