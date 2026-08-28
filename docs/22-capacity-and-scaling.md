# Capacity and scaling — what runs where, and how to grow it

The Gateway is deliberately a **single ECS Fargate task** (`desiredCount: 1`):
every real-time surface — SSE boards, `/rig` bridge sockets, RTC signalling,
contact presence, the LLM agent worker — terminates in one Node process whose
state is rebuilt from DynamoDB on boot (`gateway/src/state.js:42`). This doc
maps the deployed infrastructure as it is, defines what "capacity reached"
means for that one task, and lays out the phases for growing past it.

The one rule to internalise first: **`desiredCount: 2` today would be a bug,
not a scale-out.** The ALB round-robins a single target group; a participant's
SSE stream lands on task A while their caption POST lands on task B, and B has
no subscriber to fan out to. Never raise `desiredCount` without the Phase 2
routing work below.

---

## 1. The existing cloud infrastructure

Nine CDK stacks per environment (`infra/bin/kelabo.js`, prefix
`kelabo-<env>`), plus `-waf` when `allowIps` is set. Everything env-specific is
derived in `config/loadConfig.mjs`.

```
                                        Route53 (imported hosted zone)
                                        portal.<domain>      gw.<env>.<domain>
                                              │                     │
  ┌───────────── BROWSER (SPA) ─────────────┐ │                     │
  │  mic → STT (Deepgram/Soniox, DIRECT —   │ │                     │
  │  never through our infra)               │ │                     │
  │  conference audio → Cloudflare Realtime │ │                     │
  └───────┬──────────────────────┬──────────┘ │                     │
          │ static + /api        │ captions/SSE/WSS/rtc             │
          ▼                      ▼                                  │
  ┌──────────────────┐   ┌─────────────────────────────────────────┐│
  │  CloudFront      │   │  ALB  kelabo-<env>-gateway              ││
  │  (us-e-1 cert,   │   │  HTTPS 443, idle timeout 240s,          ◄┘
  │  optional WAF    │   │  health /health, allowIps → listener    │
  │  when allowIps)  │   │  rules, /internal/* always forwarded    │
  ├──────────────────┤   └───────────────────┬─────────────────────┘
  │ default → S3     │                       ▼
  │  portal bucket   │   ┌─────────────────────────────────────────┐
  │  (OAC, SPA       │   │  ECS Fargate: cluster kelabo-<env>      │
  │  fallback fn)    │   │  ONE task (desiredCount: 1, cpu 512,    │
  │ /api* → HTTP API │   │  mem 1024, :latest from ECR, public     │
  │  (strip prefix,  │   │  subnet of the DEFAULT VPC)             │
  │  origin secret)  │   │                                         │
  └────────┬─────────┘   │  node:http server.js                    │
           ▼             │  ├ POST /caption        (ingest)        │
  ┌──────────────────┐   │  ├ GET  /caption/replies (SSE hub)      │
  │ API GW HTTP API  │   │  ├ WSS  /rig            (agent bridge)  │
  │ ANY /{proxy+}    │   │  ├ /rtc/*               (CF SFU proxy)  │
  └────────┬─────────┘   │  ├ /presence/stream     (contact pres.) │
           ▼             │  ├ /internal/*          (REST→GW JWT)   │
  ┌──────────────────┐   │  └ worker_thread: LLM agent             │
  │ Lambda rest-api  │   │    (gate → orchestrator → subagents)    │
  │ Node 20, 512MB,  │   └──────────┬──────────────────────────────┘
  │ 30s timeout      │──────────────┘  /internal/* calls (60s JWT,
  └────────┬─────────┘                 shared cookie signing key)
           │
           ▼  (both Lambda and ECS task role, least-privilege per table)
  ┌────────────────────────────────────────────────────────────────┐
  │ DynamoDB (PAY_PER_REQUEST): kelabos, history, users, otp,      │
  │ refresh, mcp(CMK), contacts, credentials(CMK), journeys        │
  │ S3 archives bucket · Secrets Manager (cookie key, OIDC, origin)│
  │ SES identity (conditional) · ECR kelabo-<env>-gateway          │
  └────────────────────────────────────────────────────────────────┘
```

Facts that shape everything below:

- **Heavy media never touches our infrastructure.** STT is browser→provider
  direct; conference audio is browser→Cloudflare (the Gateway only proxies the
  SFU *API*, `gateway/src/rtc/`). The task carries JSON, sockets and LLM I/O.
- The Gateway is exposed by its **own ALB** (`gw.<env>.<domain>`), not through
  CloudFront. SSE, WSS and `/rtc/*` share the one HTTPS listener; idle timeout
  is 240s for the long-lived streams (`infra/lib/gateway-ecs-stack.js:167`).
- The task runs in the **default VPC, public subnet, single AZ at a time** —
  a deploy or crash drops every live room for ~60s (clients reconnect, state
  rehydrates from DynamoDB).
- Fargate sizing comes entirely from config: `gateway.cpu` / `memoryMiB` /
  `desiredCount` in `config/kelabo.json` per env, written into the task
  definition by `infra/lib/gateway-ecs-stack.js` — which is why sizing changes
  need `make gateway`, never `make restart`.
- Clients are **handed** the gateway URL rather than hard-coding it: the join
  response gives the browser `gatewayBaseUrl` (`rest-api/src/join.js`),
  device-code redeem gives it to the connector (`rest-api/src/agent.js`), and
  the Lambda reads one env var (`KELABO_GATEWAY_BASE_URL`) for `/internal/*`
  calls. This is the routing hook Phase 2 stands on.

## 2. What "capacity reached" means

The task is one Node process: the main event loop owns every socket, and the
agent runs in a `worker_thread` beside it. Bottlenecks, in the order they are
likely to bind:

| Resource | Consumed by | Signal |
|---|---|---|
| **CPU** (0.5 vCPU default) | JSON fan-out, SSE writes, agent worker streaming | ECS `CPUUtilization`, event-loop lag |
| **Memory** (1 GB default) | per-kelabo agent contexts (full transcripts + orchestrator threads), SSE/WSS buffers | ECS `MemoryUtilization` — OOM kills the task and drops every room |
| **Connections** | 1 SSE per participant + presence streams + `/rig` sockets | ALB `ActiveConnectionCount` per target |
| **LLM throughput** | uncapped since `maxConcurrentRuns` defaulted to 0 (doc 21 §1.2) — the provider account quota is the real ceiling | provider 429s |

### Phase 0 — make it observable (do first, ~zero cost)

CloudWatch alarms on `CPUUtilization` > 70% and `MemoryUtilization` > 75% for
the gateway service, plus ALB `ActiveConnectionCount` and
`TargetResponseTime`; add an event-loop-lag gauge to the gateway's existing
log stream. Without this the first capacity signal is a dead room.

## 3. Phase 1 — vertical scaling (config-only, available today)

Fargate scales to **16 vCPU / 120 GB**. The knobs already exist:

```json
"gateway": { "cpu": 2048, "memoryMiB": 4096, "desiredCount": 1 }
```

then `make gateway env=<env>`. A 4 vCPU / 8 GB task comfortably runs hundreds
of concurrent kelabos of this workload — roughly a 30× headroom lever with no
code change. **Exhaust this lever first.** What it does not fix: the
single-task blast radius (one deploy still interrupts every room briefly).

## 4. Phase 2 — horizontal: shard kelabos across instances

The state audit behind this doc found the kelabo-scoped core — captions, SSE
board, RTC rooms, tunnel transcript routing, agent contexts, gate counters,
minutes/end/archive — is **strictly per-kelabo**: no request for kelabo A ever
reads kelabo B's state. So the natural scale-out is not shared state; it is
**pinning each kelabo to one instance**, preserving the single-writer-per-
kelabo invariant the design already assumes everywhere (one MainAgent thread,
one gate counter map, one RTC roster).

### The design

1. **N single-task ECS services** (`gw-0`, `gw-1`, …) behind **one ALB** with
   host-header rules (`gw-0.<env>.<domain>` → target group 0, …); one cert
   with SANs or a wildcard. Each service keeps `desiredCount: 1` — **the unit
   of scale is a shard, not a replica.** `shardCount` becomes a config value.
2. **Shard assignment at kelabo creation.** The REST API picks a shard (hash
   of kelaboId, or least-loaded via a heartbeat row) and stamps
   `gatewayShard` on the kelabo META.
3. **Join and redeem return the shard's URL.** The SPA and connector already
   consume whatever URL they are handed — unchanged.
4. **Lambda `/internal/*` calls route by the kelabo's stored shard** instead
   of the single `KELABO_GATEWAY_BASE_URL`.
5. **Boot rehydration filters to the instance's own shard**
   (`rebuildState`, `state.js:42`).

### The three real exceptions, and their fixes

| Exception | Why it breaks | Fix |
|---|---|---|
| **Contact presence + rings.** Identity/tenant-keyed, not kelabo-keyed; `state.js:27` explicitly documents the one-process assumption, and `presence.isInKelabo` scans every kelabo's SSE subscribers | a ring must reach targets whose presence streams live on other shards | Designate shard 0 the **presence home**: all `/presence/stream` connections and ring fan-out land there (presence is light — pings and rosters). If presence itself ever outgrows one instance: DynamoDB-backed presence, with REST fanning `/internal/ring` to all shards. |
| **One `/rig` socket multiplexes several kelabos** (`gateway/src/tunnel.js`, per-conn `kelabos`/`prepKelabos` sets) | a developer attending kelabos on two shards cannot serve both over one socket to one instance | Connector opens **one tunnel per shard URL** it has been handed (it already receives the URL at redeem; make it per kelabo). Contained connector change. |
| **`maxConcurrentRuns` as a global valve** | a configured positive cap becomes per-shard, i.e. N× the intended total | Already default-unlimited (doc 21 §1.2); document that a positive value caps *per shard*. |

Housekeeping to do while in there: per-instance credential caches are fine as
is (independent 5-minute TTL windows, read-through from DynamoDB), and
`state.uttSeq` (`state.js:16`) is dead and should be removed.

### What Phase 2 buys beyond capacity

Blast radius. Deploys can roll shard-by-shard, and a crash drops 1/N of the
live rooms instead of all of them.

### Effort

Infra (services, target groups, host rules, config-driven `shardCount`)
~1–2 days; REST shard assignment + internal-call routing ~1 day; connector
multi-tunnel ~1 day; presence home ~0.5 day; tests and docs ~1 day. All of it
belongs on `master` — a self-hoster benefits identically.

## 5. Phase 3 — shared-state replicas (avoid)

True `desiredCount > 1` *within* a shard — any instance serves any kelabo —
needs an external pub/sub for SSE fan-out (Redis/ElastiCache or DynamoDB
Streams), shared presence, and sticky WSS routing: a large rewrite of
`sseHub`, `tunnel` and `rtcRooms` for a problem Phase 2 already solves with
N× capacity. The per-kelabo ceiling (one room's participants on one instance)
is thousands of SSE connections — not a realistic meeting size. Do not plan
for this phase; record it only so nobody reinvents it as a first resort.

## 6. Summary

| Phase | Trigger | Change | Cost |
|---|---|---|---|
| 0. Observability | now | CloudWatch alarms + event-loop-lag metric | hours |
| 1. Vertical | CPU/mem alarm fires | `cpu`/`memoryMiB` in config, `make gateway` | config-only, ~30× headroom |
| 2. Kelabo sharding | vertical exhausted, or blast radius unacceptable | N single-task services, shard stamped on META, URL-per-kelabo (hook exists), presence home, connector multi-tunnel | ~1 week |
| 3. Shared state | one kelabo outgrows one instance (unlikely) | Redis pub/sub rewrite | avoid |
