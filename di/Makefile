.ONESHELL:
.DEFAULT_GOAL := help

-include Makefile.overrides # allow user specific optional overrides
-include .env # allow user specific optional environment variables

export

.PHONY: build
build: ## build the project
	@npm run build

.PHONY: test
test: ## run all test
	@npm test

.PHONY: testcov
testcov: ## run all test with coverage
	@npm run test:coverage:html
	@open coverage/index.html

.PHONY: testtypes
testtypes: ## run all type checks
	@npm run test:typecheck

.PHONY: testmem
testmem: ## run memory leak tests
	@npm run test:memory

.PHONY: ci
ci: ## run all ci commands
	@npm run test:typecheck
	@npm test
	@npm run lint:fix

.PHONY: bench
bench: ## run benchmarks
	@npm run bench

.PHONY: bench-compare
bench-compare: ## run benchmarks comparison
	@npm run bench:compare

.PHONY: perf-compare
perf-compare: ## run performance comparison
	@npm run bench:perf-compare

.PHONY: fmt
fmt: ## format code
	@npm run lint:fix

.PHONY: lint
lint: ## check lint errors
	@npm run lint
	@npm run lint:markdown

.PHONY: lintfix
lintfix: ## fix lint errors
	@npm run lint:fix

.PHONY: all
all: ## run the whole build and quality checks
	@npm run build
	@npm run test:typecheck
	@npm run lint:fix
	@npm test
	@npm run test:memory
	@npm run test:browser
@npm run test:deno

.PHONY: rebuild
rebuild: ## rebuild main library and typecheck all examples
	@npm run build
	@npm run typecheck --workspaces --if-present

.PHONY: site
site: ## start the documentation site locally
	@cd site && npm start

# Misc
# --

.PHONY: help
help: ## show help
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
