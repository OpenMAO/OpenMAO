NPM ?= npm

.DEFAULT_GOAL := check

.PHONY: install lint format typecheck test check api demo demo-approve demo-deny verify-chain console keys clean

install:
	$(NPM) install

lint:
	$(NPM) run lint

format:
	$(NPM) run format

typecheck:
	$(NPM) run typecheck

test:
	$(NPM) run test

check:
	$(NPM) run check

api:
	$(NPM) run api

demo:
	$(NPM) run demo

demo-approve:
	$(NPM) run demo-approve

demo-deny:
	$(NPM) run demo-deny

verify-chain:
	$(NPM) run verify-chain

keys:
	$(NPM) run keys

console:
	$(NPM) run console

clean:
	rm -rf dist build coverage .turbo .tsbuildinfo
