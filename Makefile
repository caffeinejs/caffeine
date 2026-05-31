.ONESHELL:
.DEFAULT_GOAL := help

-include Makefile.overrides # allow user specific optional overrides
-include .env # allow user specific optional environment variables

export

.PHONY: install
install: ## install dependencies
	@npm install

.PHONY: build
build: ## build all packages
	@npm run build

.PHONY: build-force
build-force: ## force rebuild all packages
	@npm run build:force

.PHONY: clean
clean: ## remove build artifacts
	@npm run clean

.PHONY: test
test: ## run all tests
	@npm test

.PHONY: ci
ci: ## run all ci checks
	@npm run fmt:check
	@npm run lint
	@npm run build
	@npm test

.PHONY: ci-fix
ci-fix: ## run all ci checks but with fixes enabled
	@npm run fmt
	@npm run lint:fix
	@npm run build
	@npm test

.PHONY: fmt
fmt: ## format code
	@npm run fmt

.PHONY: fmt-check
fmt-check: ## check code formatting
	@npm run fmt:check

.PHONY: lint
lint: ## check lint and fix errors
	@npm run lint:fix

.PHONY: lint-check
lint-check: ## check lint without fixing
	@npm run lint

# Misc
# --

.PHONY: help
help: ## show help
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
