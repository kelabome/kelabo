# Kelabo — routine tasks, always scoped to an endpoint and an AWS profile.
# Run `make help` for the target list. Target docs live in the `## ` comments
# below, so keep them in sync when adding a target.

env ?= dev
AWS_PROFILE ?= default
export AWS_PROFILE

# Lazy + memoised: resolving the region shells out to node and needs a valid
# config/kelabo.json, so it must not run for targets that don't deploy anything
# (help, check, bootstrap). `=` defers it; the eval caches it after first use.
REGION = $(eval REGION := $(shell cd config && KELABO_ENV=$(env) node --input-type=module -e "import('./loadConfig.mjs').then(m=>console.log(m.loadConfig(process.env.KELABO_ENV).region))"))$(REGION)
STACK_PREFIX := kelabo-$(env)

.PHONY: help deploy infra docker gateway restart backend frontend synth secrets rtc-secrets bootstrap test check \
	origin-secret stt-key stt-adopt mail-secret \
	allow-list allow-ip allow-rm \
	agent-login agent-pack agent-publish agent-release agent-tarball connector-install install-connector install-oc-connector \
	install-cc-connector uninstall-connector uninstall-oc-connector uninstall-cc-connector

.DEFAULT_GOAL := help

CLUSTER := kelabo-$(env)
SERVICE := kelabo-$(env)-gateway

help: ## show this help
	@echo "Kelabo — usage: make <target> [env=dev|staging|prod]"
	@echo "current: env=$(env) AWS_PROFILE=$(AWS_PROFILE)"
	@echo
	@echo "verify (no AWS needed):"
	@awk 'BEGIN{FS=":.*## "} /^(help|check|test|bootstrap):.*## /{printf "  %-14s %s\n",$$1,$$2}' $(MAKEFILE_LIST)
	@echo
	@echo "agent bridge on this machine (one package, one \`kelabo\`, every runtime):"
	@awk 'BEGIN{FS=":.*## "} /^(connector-install|install-connector|install-oc-connector|install-cc-connector|uninstall-connector|uninstall-oc-connector|uninstall-cc-connector):.*## /{printf "  %-22s %s\n",$$1,$$2}' $(MAKEFILE_LIST)
	@echo
	@echo "release @kelabome/agents to npm:"
	@awk 'BEGIN{FS=":.*## "} /^(agent-login|agent-pack|agent-publish|agent-release):.*## /{printf "  %-14s %s\n",$$1,$$2}' $(MAKEFILE_LIST)
	@echo
	@echo "deploy (needs AWS creds + config/kelabo.json):"
	@awk 'BEGIN{FS=":.*## "} /^(deploy|infra|docker|reserver|gateway|restart|backend|frontend|synth|secrets):.*## /{printf "  %-10s %s\n",$$1,$$2}' $(MAKEFILE_LIST)
	@echo
	@echo "access control (allowIps — empty means open):"
	@awk 'BEGIN{FS=":.*## "} /^(allow-list|allow-ip|allow-rm):.*## /{printf "  %-12s %s\n",$$1,$$2}' $(MAKEFILE_LIST)
	@echo
	@echo "notes: the ECS task pins the mutable :latest tag, so \`make docker\` alone"
	@echo "       does not roll the service — follow it with \`make restart\`."
	@echo "       rig (dev-mode opencode): make -f rig/Makefile rig-setup|rig-build|rig-up"

deploy: ## full deploy: docker push -> cdk deploy --all -> ECS restart -> SPA
	./scripts/deploy.sh $(env)

infra: ## cdk deploy --all
	cd infra && npx cdk deploy -c env=$(env) --all --require-approval never

docker: ## build + push the gateway image to ECR
	./scripts/build-push-gateway.sh $(env)

reserver: ## rebuild gateway docker and restart gateway ECS
	make docker restart

gateway: docker ## docker push + redeploy the gateway stack
	cd infra && npx cdk deploy -c env=$(env) $(STACK_PREFIX)-gateway --require-approval never

# Force the single ECS task to be replaced so it re-pulls the (mutable) :latest
# image tag — use after `make docker` to roll out a new image without a CDK deploy.
restart: ## force ECS to replace the task (re-pull :latest) and wait for stable
	aws ecs update-service --cluster $(CLUSTER) --service $(SERVICE) \
	  --force-new-deployment --region $(REGION) \
	  --query "service.{service:serviceName,desired:desiredCount,taskDef:taskDefinition}" --output table
	@echo ">> waiting for service to stabilize (this replaces the running task)…"
	aws ecs wait services-stable --cluster $(CLUSTER) --service $(SERVICE) --region $(REGION)
	@echo "== ECS $(SERVICE) restarted (new task running latest image) =="

backend: ## deploy the rest-api (lambda + api stacks)
	cd infra && npx cdk deploy -c env=$(env) $(STACK_PREFIX)-lambda $(STACK_PREFIX)-api --require-approval never

frontend: ## build the SPA + s3 sync + CloudFront invalidation
	./scripts/deploy-frontend.sh $(env)

synth: ## cdk synth (offline-safe)
	cd infra && npx cdk synth -c env=$(env)

origin-secret: ## create the CloudFront->API shared secret (generated, idempotent)
	@aws secretsmanager describe-secret --secret-id kelabo/$(env)/api-origin --region $(REGION) >/dev/null 2>&1 \
	  && echo "kelabo/$(env)/api-origin already exists — left alone (rotating it needs the portal and the Lambda redeployed together)" \
	  || (aws secretsmanager create-secret --name kelabo/$(env)/api-origin --secret-string "$$(openssl rand -hex 32)" --region $(REGION) --tags Key=app,Value=kelabo Key=endpoint,Value=$(env) >/dev/null \
	      && echo "created kelabo/$(env)/api-origin")

secrets: origin-secret ## create/update secrets (needs STT_PROVIDER=.. STT_API_KEY=.. LLM_API_KEY=..)
	@test -n "$(STT_PROVIDER)" || (echo "STT_PROVIDER required (the id in config stt.provider, e.g. deepgram)"; exit 1)
	@test -n "$(STT_API_KEY)" || (echo "STT_API_KEY required"; exit 1)
	@test -n "$(LLM_API_KEY)" || (echo "LLM_API_KEY required"; exit 1)
	aws secretsmanager describe-secret --secret-id kelabo/$(env)/cookie-key --region $(REGION) >/dev/null 2>&1 \
	  || aws secretsmanager create-secret --name kelabo/$(env)/cookie-key --secret-string "$$(openssl rand -hex 48)" --region $(REGION) --tags Key=app,Value=kelabo Key=endpoint,Value=$(env)
	$(MAKE) stt-key env=$(env) provider=$(STT_PROVIDER) key=$(STT_API_KEY)
	aws secretsmanager describe-secret --secret-id kelabo/$(env)/llm --region $(REGION) >/dev/null 2>&1 \
	  && aws secretsmanager put-secret-value --secret-id kelabo/$(env)/llm --secret-string '{"apiKey":"$(LLM_API_KEY)","provider":"deepseek"}' --region $(REGION) \
	  || aws secretsmanager create-secret --name kelabo/$(env)/llm --secret-string '{"apiKey":"$(LLM_API_KEY)","provider":"deepseek"}' --region $(REGION) --tags Key=app,Value=kelabo Key=endpoint,Value=$(env)
	@echo "secrets ready for env=$(env)"

# One key for one transcription provider, MERGED into kelabo/<env>/stt rather
# than replacing it. The secret holds a key per provider so that switching
# provider — or rolling back after a switch — is a config change and a redeploy,
# never a scramble to re-enter a credential:
#
#   { "deepgram": "…", "soniox": "…" }
#
# The Lambda reads whichever one `stt.provider` names (rest-api/src/secrets.js).
stt-key: ## add/replace one provider's STT key (provider=deepgram key=..)
	@test -n "$(provider)" || (echo "provider required, e.g. provider=deepgram"; exit 1)
	@test -n "$(key)" || (echo "key required"; exit 1)
	@command -v python3 >/dev/null || (echo "python3 required to merge the secret"; exit 1)
	@existing=$$(aws secretsmanager get-secret-value --secret-id kelabo/$(env)/stt --region $(REGION) \
	    --query SecretString --output text 2>/dev/null || echo '{}'); \
	  merged=$$(python3 -c 'import json,sys; raw=(sys.argv[1] or "").strip() or "{}"; d=json.loads(raw); d=d if isinstance(d,dict) else {}; d[sys.argv[2]]=sys.argv[3]; print(json.dumps(d))' "$$existing" "$(provider)" "$(key)"); \
	  aws secretsmanager describe-secret --secret-id kelabo/$(env)/stt --region $(REGION) >/dev/null 2>&1 \
	    && aws secretsmanager put-secret-value --secret-id kelabo/$(env)/stt --secret-string "$$merged" --region $(REGION) >/dev/null \
	    || aws secretsmanager create-secret --name kelabo/$(env)/stt --secret-string "$$merged" --region $(REGION) --tags Key=app,Value=kelabo Key=endpoint,Value=$(env) >/dev/null
	@echo "stt key set for provider=$(provider) env=$(env)"

# Kept out of `secrets` on purpose: a deployment sending through SES needs no
# key at all — the Lambda authenticates with its own IAM role — so this is only
# for the deployments that cannot use SES. That is not a rare case: SES
# production access is granted case by case and is regularly refused, and a
# permanently sandboxed account can mail only addresses verified one at a time.
#
# Merged per provider, like the STT secret, so switching provider or rolling
# back after a switch never means re-entering a credential:
#
#   { "mailersend": "…" }
#
# The Lambda reads whichever one `mail.provider` names (rest-api/src/secrets.js).
# Needs `make backend` (not `make restart`) to take effect the first time,
# because the read grant and KELABO_MAIL_PROVIDER live in the task's IAM policy
# and environment.
mail-secret: ## add/replace the outbound mail API key (provider=mailersend key=..)
	@test -n "$(provider)" || (echo "provider required, e.g. provider=mailersend"; exit 1)
	@test -n "$(key)" || (echo "key required"; exit 1)
	@command -v python3 >/dev/null || (echo "python3 required to merge the secret"; exit 1)
	@existing=$$(aws secretsmanager get-secret-value --secret-id kelabo/$(env)/mail --region $(REGION) \
	    --query SecretString --output text 2>/dev/null || echo '{}'); \
	  merged=$$(python3 -c 'import json,sys; raw=(sys.argv[1] or "").strip() or "{}"; d=json.loads(raw); d=d if isinstance(d,dict) else {}; d[sys.argv[2]]=sys.argv[3]; print(json.dumps(d))' "$$existing" "$(provider)" "$(key)"); \
	  aws secretsmanager describe-secret --secret-id kelabo/$(env)/mail --region $(REGION) >/dev/null 2>&1 \
	    && aws secretsmanager put-secret-value --secret-id kelabo/$(env)/mail --secret-string "$$merged" --region $(REGION) >/dev/null \
	    || aws secretsmanager create-secret --name kelabo/$(env)/mail --secret-string "$$merged" --region $(REGION) --tags Key=app,Value=kelabo Key=endpoint,Value=$(env) >/dev/null
	@echo "mail key set for provider=$(provider) env=$(env) — set mail.provider in config/kelabo.json, then 'make backend env=$(env)'"

# Migration for a deployment that predates the STT provider boundary, where the
# key lived in a secret named after the provider (kelabo/<env>/deepgram). Copies
# it into kelabo/<env>/stt under that provider's id, so the same credential keeps
# working and nothing has to be re-entered from a vendor console.
#
# Run this BEFORE `make backend`: config now points the Lambda at the new secret,
# and until it exists /stt-token answers stt_unavailable. Idempotent, and it
# leaves the old secret alone — delete that by hand once the deploy is verified.
stt-adopt: ## migrate kelabo/<env>/<provider> into kelabo/<env>/stt (provider=deepgram)
	@test -n "$(provider)" || (echo "provider required, e.g. provider=deepgram"; exit 1)
	@old=$$(aws secretsmanager get-secret-value --secret-id kelabo/$(env)/$(provider) --region $(REGION) \
	    --query SecretString --output text 2>/dev/null) || (echo "kelabo/$(env)/$(provider) not found — nothing to adopt"; exit 1); \
	  key=$$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print(d.get("apiKey") or d.get("key") or d.get("value") or "")' "$$old"); \
	  test -n "$$key" || (echo "no apiKey/key/value in kelabo/$(env)/$(provider)"; exit 1); \
	  $(MAKE) --no-print-directory stt-key env=$(env) provider=$(provider) key="$$key"
	@echo "adopted $(provider) into kelabo/$(env)/stt (old secret left in place)"

# Kept out of `secrets` on purpose: conference audio is optional. Without this
# secret the Gateway answers /rtc/* with rtc_unavailable and kelabos still run
# with transcript + board, so an existing deployment does not break.
rtc-secrets: ## Cloudflare Realtime creds (CF_SFU_APP_ID=.. CF_SFU_APP_SECRET=.. [CF_TURN_KEY_ID=.. CF_TURN_KEY_TOKEN=..])
	@test -n "$(CF_SFU_APP_ID)" || (echo "CF_SFU_APP_ID required"; exit 1)
	@test -n "$(CF_SFU_APP_SECRET)" || (echo "CF_SFU_APP_SECRET required"; exit 1)
	$(eval CF_JSON := {"sfuAppId":"$(CF_SFU_APP_ID)","sfuAppSecret":"$(CF_SFU_APP_SECRET)","turnKeyId":"$(CF_TURN_KEY_ID)","turnKeyApiToken":"$(CF_TURN_KEY_TOKEN)"})
	aws secretsmanager describe-secret --secret-id kelabo/$(env)/cloudflare-realtime --region $(REGION) >/dev/null 2>&1 \
	  && aws secretsmanager put-secret-value --secret-id kelabo/$(env)/cloudflare-realtime --secret-string '$(CF_JSON)' --region $(REGION) \
	  || aws secretsmanager create-secret --name kelabo/$(env)/cloudflare-realtime --secret-string '$(CF_JSON)' --region $(REGION) --tags Key=app,Value=kelabo Key=endpoint,Value=$(env)
	@echo "cloudflare realtime secret ready for env=$(env) — run 'make restart env=$(env)' to pick it up"

# `allowIps` — who may reach the deployment at all. Adding an address writes
# config/kelabo.json *and* edits AWS live, so the two cannot drift and a new
# address works in seconds. The exception is the first lock and the last
# unlock, which change CDK-owned resources and say so.
allow-list: ## show the source addresses allowed to reach this env, config vs live
	@scripts/allowlist.sh $(env) list

allow-ip: ## allow a source address (IP=1.2.3.4/32, or omit for this device)
	@scripts/allowlist.sh $(env) add $(if $(IP),$(IP),this)

allow-rm: ## stop allowing a source address (IP=1.2.3.4/32)
	@test -n "$(IP)" || (echo "IP required, e.g. make allow-rm env=$(env) IP=1.2.3.4/32"; exit 1)
	@scripts/allowlist.sh $(env) rm $(IP)

bootstrap: ## npm install in every package (root + 6 components)
	npm install
	cd contracts && npm install
	cd infra && npm install
	cd rest-api && npm install
	cd gateway && npm install
	cd connector && npm install
	cd spa && npm install

test: ## all smoke tests + spa build + cdk synth
	cd contracts && npm test
	cd rest-api && npm test
	cd gateway && npm test
	cd connector && npm test
	cd spa && npm test && npm run build
	cd infra && npx cdk synth -c env=$(env) >/dev/null && echo "cdk synth $(env) OK"

agent-pack: ## build the publishable npm package into connector/dist/agent/
	@# Self-sufficient on a fresh clone: the pack bundles contracts (zod and all)
	@# through esbuild, so both packages need their node_modules before the
	@# first `make install-connector` can work without a `make bootstrap`.
	@test -d contracts/node_modules || { echo ">> fresh clone — npm install in contracts/"; cd contracts && npm install --no-audit --no-fund --silent; }
	@test -d connector/node_modules || { echo ">> fresh clone — npm install in connector/"; cd connector && npm install --no-audit --no-fund --silent; }
	cd connector && npm run pack && npm test

agent-login: ## npm login for the kelabo org (interactive — run from your terminal)
	npm login
	@npm whoami && npm org ls kelabome | grep -q "$$(npm whoami)" && echo "== logged in with @kelabome publish rights ==" \
	  || echo "!! this account is not in the kelabome org — publishes will 403"

agent-publish: ## publish @kelabome/agents (agent-pack first; with 2FA pass otp=123456)
	cd connector && npm publish ./dist/agent --access public $(if $(otp),--otp=$(otp))

# The whole release, one verb. The version bumps exactly at publish time and
# nowhere else — day-to-day local work runs from paths (`file:` specs, `make
# connector-install`) and never needs a number. Which LEVEL to bump is a human
# decision (level=patch|minor|major, default patch); everything after it is
# mechanics: bump, rebuild, test, publish, commit, tag. The registry refusing
# duplicate versions is the backstop that keeps this honest.
agent-release: ## bump + pack + test + publish @kelabome/agents + git tag (level=patch|minor|major)
	@test -z "$$(git status --porcelain connector)" || { echo "connector/ has uncommitted changes — commit first"; exit 1; }
	@cd connector && npm version $(or $(level),patch) --no-git-tag-version >/dev/null
	@if $(MAKE) agent-pack && ( cd connector && npm publish ./dist/agent --access public $(if $(otp),--otp=$(otp)) ); then \
	  VER=$$(node -p "require('./connector/package.json').version") && \
	  git add connector/package.json && \
	  git commit -q -m "release: @kelabome/agents v$$VER" && \
	  git tag "agent-v$$VER" && \
	  echo "== published @kelabome/agents v$$VER and tagged agent-v$$VER =="; \
	else \
	  echo "!! publish failed — reverting the version bump so the next attempt starts clean"; \
	  git checkout -- connector/package.json; \
	  exit 1; \
	fi

# --- installing the bridge locally, exactly as a user would ------------------
#
# `npm i -g connector/dist/agent` would *symlink* the directory, which is handy
# for iterating and is not what anybody else will get. These targets build a real
# tarball and install that, so what is tested here is what the registry would
# serve — including the `files` list, the bin shebang and the symlinked bin
# (which is its own failure mode; see `invokedDirectly` in cli.js).
#
# There is one package and one `kelabo` command for every runtime, so the install
# happens once. What differs per runtime is `setup`, which edits that runtime's
# config file and records what it wrote in ~/.kelabo/install-<runtime>.json.
# opencode and Claude Code coexist by design: separate configs, separate
# manifests, one shared pairing.
AGENT_TARBALL = connector/dist/kelabo-agent.tgz

agent-tarball: agent-pack
	@cd connector/dist && rm -f kelabo-agent.tgz && \
	  tgz=$$(npm pack ./agent --silent) && mv "$$tgz" kelabo-agent.tgz
	@echo "  packed $(AGENT_TARBALL)"

connector-install: agent-tarball ## npm i -g the built bridge (no config changes)
	npm install -g $(AGENT_TARBALL)
	@kelabo --version >/dev/null && echo "  installed: kelabo $$(kelabo --version)"

install-oc-connector: connector-install ## install + wire opencode
	kelabo setup --runtime opencode

install-cc-connector: connector-install ## install + wire Claude Code
	kelabo setup --runtime claude-code

install-connector: connector-install ## install + wire every runtime on this machine
	kelabo setup --all

# Config first, package second: `uninstall` needs the CLI to still exist, and it
# is what knows which keys are ours and which the developer has since edited.
uninstall-oc-connector: ## remove the opencode wiring (leaves the package installed)
	kelabo uninstall --runtime opencode

uninstall-cc-connector: ## remove the Claude Code wiring (leaves the package installed)
	kelabo uninstall --runtime claude-code

uninstall-connector: ## remove every runtime's wiring, the credential, and the package
	-kelabo uninstall --all --purge
	npm rm -g @kelabome/agents

check: ## node --check over every .js/.mjs (syntax only; skips spa/src)
	@find config contracts/src infra/bin infra/lib rest-api/src gateway/src connector/src connector/build rig -name "*.js" -o -name "*.mjs" | grep -v node_modules | xargs -I{} node --check {} && echo "syntax OK"
