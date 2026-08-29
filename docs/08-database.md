# 08 — Database Design

**DynamoDB** (single-table-friendly, but split into a few tables for clarity + TTL/
GSI needs) plus **S3** for large transcripts. Everything is PAY_PER_REQUEST, PITR on
durable tables. Every item carries `tenantId` (= verified email domain; a single
tenant for self-host). Schema reused from the prior art
where it fits (ARCHITECTURE §15.8), add OTP + MCP.

---

## 1. Tables overview

| Table | PK | SK | GSIs | TTL | Purpose |
|-------|----|----|------|-----|---------|
| `kelabo-<env>-kelabos` | `PK` | `SK` | `status-index` | on ended items | kelabos + participants + live transcript/board |
| `kelabo-<env>-history` | `archiveId` | — | `participant-index` | none (permanent) | archived kelabos (summary rows) |
| `kelabo-<env>-users` | `USER#<email>` | — | — | none | registered users |
| `kelabo-<env>-otp` | `OTP#<email>` | — | — | yes (~10 min) | pending OTP codes + rate counters |
| `kelabo-<env>-refresh` | `RT#<tokenId>` | — | `identity-index` | yes (~30–90d) | rotating, revocable refresh tokens (long sessions) |
| `kelabo-<env>-mcp` | `MCP#<scope>` | `SK` | — | none | org/host/kelabo MCP config |
| `kelabo-<env>-contacts` | `CONTACT#<owner>` | `SK` | — | on external decline-cleanup | favourites (`FAV#`) + external links (`PEER#`) — docs 18 §4 |
| `kelabo-<env>-credentials` | `CRED#<slot>` | `META` | — | **none, deliberately** | supplier keys (LLM, STT, Cloudflare Realtime, mail) — §6c |
| `kelabo-<env>-journeys` | `PK` | `SK` | `tenant-status-index`, `accessor-index` | **none, deliberately** | journeys: container linking related kelabos — docs 20, §6b |
| `kelabo-<env>-config` | `PK` | `SK` | — | **none, deliberately** | operational configuration versions + the admin roster — §6d, docs 23 |

S3: `kelabo-<env>-archives-<acct>` — full transcript/board JSON.

> Kelabos table is used single-table style: one kelabo = a partition holding the
> meta item + child items (utterances, contributions). This gives cheap "load whole
> kelabo" queries and keeps the live transcript adjacent.

---

## 2. `kelabos` table (single-table per kelabo)

Partition per kelabo: `PK = KELABO#<kelaboId>`.

| Item | PK | SK | Key attributes |
|------|----|----|----------------|
| kelabo meta | `KELABO#<id>` | `META` | `status`(scheduled/active/ended/cancelled), `tenantStatus`, `title`, `hostIdentity`, `createdAt`, `scheduledAt?`, `durationMinutes?`, `note?`, `startedAt`, `hostJoinedAt?`, `endedAt?`, `participants[]`, `mode`(dev/server/unknown), `isDeveloperPresent`, `agentRuntime?`, `agentLabel?`, `rtcMode`, `mcpEnabled`, `hasMinutes`, `tenantId`, `ttl?` |
| utterance | `KELABO#<id>` | `UTT#<tStartPadded>#<seq>` | `speaker`, `text`, `tStart`, `tEnd`, `clientId`, `tenantId`, `source?`(typed — absent means speech), `at?`(wall clock), `messageId?`(the speaker's message id, so a history backfill dedupes against live SSE delivery) |
| contribution | `KELABO#<id>` | `CONTRIB#<at:13>#<rand6>` | `tag`, `kind`, `to`, `title`, `markdown`, `sources`, `author`, `origin`(server/local/opencode), `runtime?`, `agentLabel?`, `at`, `tenantId` |
| minutes | `KELABO#<id>` | `MINUTES` | `MinutesDoc` fields, `generatedAt`, `generatedBy` |
| agent binding (dev) | `KELABO#<id>` | `PROMOTION` | `runtime`, `sessionRef`, `workspace`, `label`, `boundBy`, `boundAt` — records **which local agent session receives transcript** (docs 16). Runtime-agnostic: `sessionRef` and `workspace` are opaque. Rows written before docs 16 carry `opencodeSessionId`/`opencodeProjectId`/`opencodeDirectory` instead and are read as `runtime: "opencode"`. |
| journey mirror | `KELABO#<id>` | `JOURNEY#<journeyId>` | `{journeyId, journeyTitleSnapshot, journeyVisibilitySnapshot, linkedAt, linkedBy}` — the backward half of a journey link (docs 20 §4.3). Exists so "does/which journey(s) does this kelabo belong to" is one `begins_with(SK, "JOURNEY#")` query on the kelabo's own partition — the purge guard and the "Part of: …" banner — **without a new GSI and without a cross-table scan**. Written together with the journey's own `LINK#` row in **one cross-table `TransactWriteItems`** conditioned on the journey not being `completed` (plus `ADD kelaboCount 1` on its META). |

**GSI `status-index`:** PK **`tenantStatus` = `<tenantId>#<status>`**, SK
`startedAt` (sparse — written only on META). Powers "list active kelabos" **scoped
to the tenant/org**: self-host has one tenant so it lists all active; a multi-domain
deployment lists only same-domain kelabos. Also serves "list mine" (filter by host).

**Meta.participants[]** (append-only): `{identity, displayName, isGuest, joinedAt}`.

**Scheduled kelabos** are the same item in an earlier state — `status:
"scheduled"`, same partition, same id, same join link — not a separate entity.
That is what lets a link be shared a week early and still be the right link once
the host starts: nothing is created or migrated at start time, a status flips.
`scheduledAt` / `durationMinutes` / `note` are added; `startedAt` is **`0`, not
unset**, because `status-index` sorts on it as a Number and DynamoDB silently
declines to index an item whose key attribute is missing or of the wrong type.

Because the id never changes, an agent preparing for a kelabo can write ordinary
`CONTRIB#` items against it *before it starts* (docs 16 §5). They persist with no
SSE subscribers and are simply already on the board when the first participant
arrives — there is no prep item type and no phase field.

**The `CONTRIB#` sort key is compared as a string, so its zero-padding width is
part of the contract.** The Gateway writes `pad(at, 13)`; a reader that pads a
`since` cursor to any other width makes `SK > :sk` true for everything and
silently replays the board from the beginning.

**Invitations** live beside the meta: `PK = KELABO#<id>`, `SK =
INVITE#<key>`, where the key is the **email address** for someone who has one
and `g:<uuid>` for a guest who only ever gave a name. One `begins_with(SK,
"INVITE#")` query lists everybody whichever they are. Fields: `{email?,
displayName?, isGuest, isHost, response: accepted|declined|pending, invitedAt,
respondedAt?}`.

**No one-active-per-host guard (removed 2026-07-31).** A host may run any
number of live kelabos at once. The old `HOSTACTIVE#<hostIdentity>` GUARD item
(written in the create TransactWrite, released on end) silently bounced a
second "create" to the existing kelabo, which read as a bug, not a rule. Create
is now a single conditional put of META; starting a scheduled kelabo is a
conditional update whose `status = scheduled` condition still stops a double
click producing two live kelabos from one schedule. End/purge paths keep
deleting `HOSTACTIVE#` rows so pre-removal rows drain away; nothing writes or
reads them.

**TTL:** `ttl` is set on META `retentionDays` after `endedAt`, and **is swept
across the rest of the partition in the same call** — `stampKelaboTtl`
(`gateway/src/db.js`), run from `endKelabo` after the minutes work, in chunks
of 20 so it does not compete with live rooms. It skips META (already stamped)
and `JOURNEY#` mirrors, which deliberately outlive the kelabo (docs 20 §4.3).
Captions that arrive after the sweep stamp themselves from the ended META's own
`ttl` (`gateway/src/caption.js`).

> This paragraph used to warn that the TTL did not cascade and that `UTT#`,
> `CONTRIB#`, `MINUTES` and `PROMOTION` rows were left orphaned holding
> transcript text. That was true before `stampKelaboTtl` existed and has not
> been true for some time.

The TTL is written **only** by `endKelabo`. A kelabo that never ends never
gets one — which is one of the structural reasons a persistent chat channel
belongs on a journey rather than on a long-lived kelabo (docs 20 §19.1).

### Retention purge (`POST /records/purge`)

User-driven, irreversible deletion of records older than `N days|weeks|months|years`.
Implemented in `rest-api/src/records.js` (`purgeRecords`); age arithmetic is
`contracts/src/retention.js` (`cutoffFromAge`), shared with the SPA so both sides
agree on what "3 months ago" means. Months/years are calendar-accurate and clamp
day-of-month overflow downwards.

Ownership decides what "delete" means — a record is shared between its host and
its participants:

| Caller | Effect |
|---|---|
| **host** | full purge: S3 archive object, the entire `KELABO#<id>` partition, the history row, and **every** participant's index row |
| **participant** | only the caller's own `PARTICIPANT#<identity>#<archiveId>` row is removed — the record leaves their list, the host's copy is untouched |

Guarantees:

- `dryRun: true` returns the identical report without deleting; the SPA always
  previews first.
- A kelabo with no `endedAt` is never purged (reported under `skipped`).
- A kelabo with any `JOURNEY#` mirror row (§2 above) is never host-purged —
  409 `kelabo_in_journey` until it is unlinked from every journey
  (docs 20 §14.3). The single-record `DELETE /records/:archiveId` host-purge
  outcome applies the same guard.
- The history row is deleted **last**: it is the only pointer to the S3 key and
  the participant list, so a mid-way failure leaves the job resumable rather than
  orphaning both.
- Capped at 50 records per call; `remaining` tells the caller to run again.
- IAM is scoped to `dynamodb:DeleteItem` on `history` and `s3:DeleteObject` on the
  archive bucket, on top of the existing read grants — the API still cannot
  *write* history rows or archive objects, which stay gateway-owned.
- PITR is enabled on `kelabos` and `history`, so purged data remains recoverable
  within the PITR window. This is not a GDPR-grade erasure.

---

## 3. `history` table (permanent archive index)

One row per ended kelabo (summary; full content in S3).

| Attr | Notes |
|------|-------|
| `archiveId` (PK) | = ended kelaboId |
| `kelaboId`, `title`, `host`, `startedAt`, `endedAt` | |
| `participantIdentities` (string set) | for access checks |
| `participantCount`, `hasMinutes` | list display |
| `s3Key` | `archives/<host>/<archiveId>.json` |
| `tenantId` | |

**GSI `participant-index`:** PK `participantIdentity` (fan-out per participant),
SK `endedAt` — powers `GET /records` ("kelabos I was in"). Implemented by writing a
lightweight `PARTICIPANT#<identity>` companion item per participant, or by a GSI over
an unrolled attribute.

No TTL — records are permanent (registered participants can always access).

---

## 4. `users` table

| Attr | Notes |
|------|-------|
| `PK = USER#<email>` | |
| `email`, `displayName` | displayName defaults to email local-part |
| `createdAt`, `lastLoginAt` | |
| `mcpOverrideRef?` | pointer to personal MCP defaults (`MCP#host#<email>`) — informational; resolution reads the mcp table directly |
| `notificationsOptIn?` | |
| `tenantId` | |

**GSI `tenant-index`:** PK `tenantId`, SK `email`, projecting `displayName`.
Answers "who is registered at this email domain, whose address starts with…" —
which is the invitee autocomplete on the schedule page. There is deliberately no
separate address-book table: the registered users *are* the list, and a parallel
copy could only ever drift from them. Everyone in a domain may see the names and
addresses of everyone else in it; the tenant is the partition key, so a query
cannot cross a domain boundary even by mistake.

Guests are **not** stored here (ephemeral; identity `guest:<uuid>` lives only in the
participant cookie + kelabo participants[]).

---

## 5. `otp` table

| Attr | Notes |
|------|-------|
| `PK = OTP#<email>` | one pending code per email |
| `codeHash` | store a hash, not the raw code |
| `expiresAt` (+ `ttl`) | ~10 min |
| `attempts` | increment on each verify; lock after N |
| `requestCount`, `windowStart` | rate-limit per email |
| `tenantId` | |

Also a per-IP rate item: `PK = OTPIP#<ip>` with `count` + `ttl` (abuse/SES cost
control).

**Agent-bridge device codes live here too** (docs 16 §6), because the table *is*
"short-lived keyed items with a TTL" and a new table would have brought the
deploy-ordering hazard with it for no gain:

| Item | PK | Notes |
|---|---|---|
| device code | `DEVICE#<deviceCode>` | `userCode`, `runtime`, `label`, `identity?`, `tenantId?`, `approvedAt?`, `expiresAt`, `ttl` (10 min) |
| user-code pointer | `USERCODE#<userCode>` | `deviceCode` only. The short code a human types must not let anyone derive the long one, which is the actual secret. |

Approval is conditional on `attribute_not_exists(approvedAt)`, and redeeming
deletes both items — one code mints exactly one token.

---

## 5a. `refresh` table (long sessions without re-OTP)

Enables short session JWTs + long-lived rotating refresh tokens so users don't
re-authenticate every open, without any password.

| Attr | Notes |
|------|-------|
| `PK = RT#<tokenId>` | random token id (the raw token is in the cookie; only its **hash** is stored) |
| `hash` | hash of the raw refresh token (verify by hashing the cookie value) |
| `identityHash` | owner (hashed email) — for `logout-all` and `identity-index` |
| `chainId` | rotation chain; reuse of a rotated token ⇒ revoke the whole chain |
| `rotatedFrom?` | previous `tokenId` in the chain |
| `revoked` | boolean; set on logout / theft detection |
| `expiresAt` (+ `ttl`) | ~30–90d (longer for "remember this device") |
| `createdAt`, `tenantId` | |

**GSI `identity-index`:** PK `identityHash` → all a user's refresh tokens (for
`POST /logout-all`). Rotation on every `/auth/refresh`: issue new, mark old revoked;
if a revoked/rotated token is presented, revoke the chain (theft response).

**Agent-bridge tokens live here too**, as `PK = AGT#<jti>` (docs 16 §6). Same
semantics as a refresh token — long-lived, revocable, listable per identity — so
they reuse the same table and the same `identity-index`, and the `PK` prefix is
what tells the two families apart. Fields: `jti`, `identity`, `identityHash`,
`tenantId`, `runtime`, `label`, `revoked`, `createdAt`, `lastSeenAt`,
`expiresAt`, `ttl` (~90d).

The Gateway is granted **`GetItem` on this table and nothing else** — it checks
whether an agent token was revoked, once per tunnel connection, and must never be
able to mint or revoke a credential, nor to enumerate the browser refresh tokens
sharing the table.

---

## 6. `mcp` table (host-scoped config)

| Scope item | PK | SK | Content |
|------------|----|----|---------|
| host defaults | `MCP#host#<identity>` | `SERVER#<name>` | host personal MCP servers (managed in Settings, `GET/PUT/DELETE /me/mcp`) |
| OAuth tokens | `MCP#host#<identity>` | `TOKEN#<name>` | `{accessToken, refreshToken, tokenType, scope, expiresAt, obtainedAt}` — never returned by any API route |
| bearer tokens | `MCP#host#<identity>` | `SECRET#<name>` | `{token, updatedAt}` — a host's pasted bearer token; never returned by any API route |
| client registrations | `MCP#client` | `AS#<issuer>` | RFC 7591 dynamic client registration, one per authorization server, shared by all users of the deployment |

**This table is encrypted with a customer-managed KMS key** (`alias/kelabo-<env>-mcp`)
because it holds third-party access *and* refresh tokens.

Effective (server mode) = the host's `MCP#host#<hostIdentity>` set, skipped when
the kelabo meta has `mcpEnabled: false` (host opt-out at creation).

Credentials by `authType`:

- `bearer` — a pasted token, stored as the `SECRET#<name>` row above, in the
  same partition as the `SERVER#<name>` it belongs to and under the same
  customer-managed key. It used to be one Secrets Manager secret per user per
  server (`kelabo/<env>/mcp/<identity>/<name>`), which put the two halves of
  "authenticate to an MCP server" in two different stores and was the only
  thing here that scaled with users × servers rather than with environments.
  No route returns it; `GET /me/mcp` reports `hasSecret`.
- `oauth` — tokens in the `TOKEN#` item above, obtained by the REST API
  (authorization-code + PKCE) and **refreshed by the gateway**, which therefore
  holds `dynamodb:PutItem` on this table plus KMS encrypt/decrypt. See
  [components/05-agent-mcp.md](components/05-agent-mcp.md) §7a.

Org-wide MCP and group ACLs are not built (would add scope rows + a resolver step).

---

## 6a. `contacts` table (favourites + external links)

One partition per owner, `PK = CONTACT#<ownerEmail>`, holding two item kinds by
SK prefix (docs 18 §4). No GSI.

| Item | PK | SK | Content |
|------|----|----|---------|
| favourite | `CONTACT#<owner>` | `FAV#<peer>` | `{owner, peer, tenantId, createdAt}` — a **private, one-way** marker pinning a same-org colleague. No row on the peer's side; nobody can query who favourited them. |
| external link | `CONTACT#<owner>` | `PEER#<peer>` | `{owner, peer, state:"outgoing"\|"incoming"\|"accepted", createdAt, respondedAt?, tenantId, peerTenantId, ttl?}` — one side of a **mirrored** cross-org link (docs 18 §4.3). |

Favourites (`FAV#`) are implemented: add is a conditional-free `Put`
(idempotent), remove a `Delete`, list a `begins_with(SK, "FAV#")` query — **no
transaction**, because a one-way marker cannot be half-written. Same-org only:
favouriting an outside address is `not_a_colleague`. The REST API has read/write;
the **Gateway has read-only** (`grantReadData`) and reads only `PEER#` rows, for
presence scope (docs 18 §5) — it never reads `FAV#`.

External links (`PEER#`) are **designed but not implemented**: they need a
multi-domain / open-signup deployment (self-host mode cannot support one), so the
routes that create them return `external_contacts_unavailable` until
`config.contacts.external` is set. When built, every external mutation is a single
`TransactWriteCommand` over both mirrored rows.

Because links are mirrored, a single `Query PK = CONTACT#<me>` answers both "who I
watch" and "who watches me", which is why there is no GSI.

---

## 6b. `journeys` table (docs 20)

One partition per journey, `PK = JOURNEY#<journeyId>` — the same single-table
style as `kelabos`. PAY_PER_REQUEST, PITR on. **No `ttl` attribute is
declared, deliberately:** a journey is long-lived by nature and never
auto-expires; every removal is an explicit write, which sidesteps the
orphaned-child trap the §2 warning documents on `kelabos`. Full field lists
and semantics: [20-journey.md](20-journey.md) §4; condensed catalogue:

| SK | Item |
|---|---|
| `META` | Root: title, visibility, status, `ownerIdentity`, `tenantId`, `tenantStatus`, health/progress, `aiCanPost`, counts, timestamps |
| `DESC#<pad(version,6)>` | Description version (immutable chain) |
| `STATUS#<pad(version,6)>` | Health/progress snapshot (immutable chain) |
| `ACCESSOR#<identity>` | Private-journey roster entry |
| `LINK#<kelaboId>` | Kelabo membership, forward half (the backward half is the `JOURNEY#` mirror on `kelabos`, §2) |
| `REPORT#<reportId>` | One Q&A report, append-only; `status: pending\|ready\|failed` |
| `BOARDMSG#<msgId>` (+ `#V#<pad(version,6)>`) | Pinned message head + its immutable version chain; archive is soft and reversible |
| `DOC#<docId>` | Pasted-text document head (inline, or `s3Key`+excerpt over the 400KB cap); removal is soft, one-way |
| `CONTRIBUTOR#<identity>` | Per-person rollup: `kelaboJoinCount`, `reportRequestCount` — maintained by `ADD` at write time, never derived by scan |
| `TL#<pad(at,13)>#<rand6>` | Timeline projection row, written in the same call as every mutation — a genuine index, not a derived one |
| `SETTLED#<kelaboId>` | Idempotency marker for `kelaboJoinCount` settling on kelabo end; no reader of its own |
| `LEG#<legId>` | One named conversation (docs 20 §19): `title`, `createdBy`, `createdAt`, `messageCount`, `lastMessageAt`, `archived`. Trunk, the default leg, has the fixed id `trunk` rather than a uuid — that is what makes lazy creation under `attribute_not_exists(SK)` idempotent when two people open a journey at once |
| `MSG#<legId>#<msgId>` | One message. `msgId` is `<pad(at,13)>-<rand6>` — the sort suffix *is* the id, so it is also the paging cursor and makes edit/delete a point read. Hyphen, not `#`: it travels in a URL path. Append-only; delete is soft (`deletedAt`, `text` REMOVEd) so `messageCount` never decreases. Also `mentions: [identity]` (resolved server-side at write time) and `pinnedAs` once promoted to the board. ⚠️ A range read must end at `MSG#<legId>$` — `MSG#trunk2#…` sorts above `MSG#trunk#…`, so a looser bound swallows a sibling leg |
| `READ#<identity>#<legId>` | Per-person, per-leg read cursor **and** mention counter: `lastReadAt`, `lastReadMsgId`, `messageCountAtRead`, `mentionCount`, `mentionCountAtRead`. Identity before legId so one query gets all of a person's cursors in a journey. Both badges are an O(1) difference, which is why neither counter decreases. ⚠️ Being mentioned **creates this row without `lastReadAt`**, so any guard on it must also test `attribute_not_exists(lastReadAt)` — DynamoDB reads `lastReadAt < :at` on a missing attribute as false, which would wedge the cursor permanently (docs 20 §19.8) — and `legId` must be read off the key, not the attribute, for the same reason |

**GSI `tenant-status-index`:** PK `tenantStatus` (`<tenantId>#<status>`, sparse —
META only), SK `updatedAt` — "journeys in my tenant", public-journey discovery,
visibility filtered in the handler (the same "query broad, filter in code"
idiom as `kelabos.status-index`).

**GSI `accessor-index`:** PK `accessorIdentity` (sparse — `ACCESSOR#` items
only), SK `addedAt` — "private journeys I'm an accessor of", a structural copy
of the kelabos `invitee-index`.

Access is shared: the REST API has read/write (the whole §11 surface of docs
20), and the **Gateway task role also has read+write** — it generates reports,
writes their `ready`/`failed` rows, reads journey context for the agent's
system prompt, settles contributor counts on kelabo end, and owns the whole
channel surface, `MSG#` and `READ#` (docs 20 §19.4)
(`infra/lib/gateway-ecs-stack.js`).

META's `messageCount` / `lastMessageAt` are journey-wide totals; the per-leg
counters that the unread badge is actually computed from live on `LEG#`.
`updatedAt` is deliberately **not** bumped by a message: it is the journey
list's sort key, and chat driving it would reorder everyone's list on every
line typed.

---

## 6c. `credentials` table (supplier keys)

One item per slot. `PK = CRED#<slot>`, `SK = META`
(`contracts/src/credentials.js`). PITR on, RETAIN, **and its own
customer-managed KMS key** (`alias/kelabo-<env>-credentials`) — so the material
can be made unreadable by disabling a key, independently of who holds
`dynamodb:GetItem`. That was the property Secrets Manager was giving us and the
one thing that had to survive the move.

| Attribute | Type | Notes |
|---|---|---|
| `slot` | S | `llm` \| `stt` \| `rtc` \| `mail` — a **closed set**; an unknown slot is refused |
| `value` | S | JSON, one key per **declared field** for that slot (below). An unknown key is refused |
| `version` | N | counts rotations |
| `rotatedAt`, `rotatedBy` | N/S | when it last moved, and who moved it |
| `createdAt` | N | the **first** write of the slot, preserved across rotations |

**Every slot declares its fields, and nothing else is accepted**
(`CREDENTIAL_FIELDS`):

| Slot | Fields | Required |
|---|---|---|
| `llm` | `apiKey` | yes |
| `stt` | `soniox`, `deepgram` | neither — `stt.provider` picks which is used, so both may be set |
| `rtc` | `sfuAppId`, `sfuAppSecret`, `turnKeyId`, `turnKeyApiToken` | the first two |
| `mail` | `mailersend` | **none** — see below |

`mail` is the only slot where an empty credential is a *working* configuration
rather than a missing one, and the exception is worth stating because it looks
like an oversight. Sending through SES needs no key at all: the Lambda
authenticates with its own IAM role. So `mailKeyFrom` answers `""` where
`sttKeyFrom` throws, and no field is `required`. The slot exists anyway, because
the day SES refuses production access is the day that stops being true.

The closed field list is not tidiness. A credential used to be a free-form JSON
blob, and one deployment's `stt` secret accumulated four keys — `soniox`,
`deepgram`, and the typos `oniox` and `onionx`. Nothing rejected them, nothing
displayed them, and the lookup accepted
`s[provider] || s.apiKey || s.key || s.value`, so a key stored under a
misspelling was indistinguishable from a correct one until the fallback chain
happened to pick differently. Three things changed together: the field list is
closed, the lookup is exact (a missing key is an error at mint time), and status
reports **per field** with any stray key listed under `unknown`.
`rest-api/scripts/migrate-credentials.mjs` normalises rather than copying
verbatim, so the typos are dropped on the way in and named in its output.

**One partition per slot, not one partition with the slot in the sort key.** A
single `PK = CRED` partition would make "list every slot" one Query — and would
make every slot readable by anything that can read one. Per-slot partitions are
what let `dynamodb:LeadingKeys` name exactly the credentials a component may
reach, which is the shape the Secrets Manager prefix grants had. The gateway
gets `CRED#llm` and `CRED#rtc`, read-only, and holds no write of any kind.

The REST API's grant is **three** statements, and the third one changed what the
first two mean. It gets the **values** of `CRED#stt` and `CRED#mail` (it mints
STT tokens and sends mail with them); `CRED#llm`/`CRED#rtc` fenced to the
non-secret attributes; and — since `/admin` gained a Suppliers tab — whole-item
`GetItem` plus `PutItem` on all four slots.

**IAM unions `Allow`, so that third statement makes the attribute fence
inert.** The property the second statement describes — the control plane can
know the LLM key exists but cannot read it — is **no longer true**. It was
traded deliberately: a self-hoster with no shell cannot run `make
credential-set`, and a console that configures everything except the four keys
the product needs is not a console. The two original statements are kept in
`infra/lib/lambda-stack.js` unchanged, because they are the exact description of
what this role would need if the console were removed.

What survives: no `Scan` (the one call that returns every credential in one
response, and the accident this design exists to prevent), no `Query`, no
`DeleteItem` (a credential is replaced, never removed, so a compromised admin
session cannot take transcription down with no way back), and the slots
enumerated from `CREDENTIAL_SLOTS` rather than matched as `CRED#*`, so an
undesigned partition key fails closed instead of being silently covered.

**What replaced the fence is an application limit, not an IAM one: no route
returns a credential value.** `credentials.getRaw` exists and `admin.js`
deliberately never calls it — `rest-api/test/admin.mjs` asserts that by reading
the source. A key can be written from the console and never read back, so a
stolen admin session can break the deployment without exfiltrating the supplier
keys it runs on. Every write logs `credential_rotated` naming the caller, the
slot and the field *names*.

**A non-secret `configured` marker, beside the value.** Always `true` —
`credentialItem` refuses an empty value, so writing the row is what it records.
It exists so that "is this capability configured?" has an answer that is not the
credential. Under Secrets Manager the control plane held `DescribeSecret` and
never `GetSecretValue`, which is why journey report synthesis runs in the
Gateway (docs 20 §6.1); in DynamoDB "does the item exist" and "what is in it"
are otherwise the same `GetItem`. `CREDENTIAL_STATUS_ATTRS` — the row minus
`value`, frozen in `contracts/src/credentials.js` — is the one list behind both
the `ProjectionExpression` of `rest-api/src/db.js`'s `getCredentialStatus` and
the `dynamodb:Attributes` + `dynamodb:Select = SPECIFIC_ATTRIBUTES` condition in
`infra/lib/lambda-stack.js`, so a projection and a policy cannot drift apart.
It includes `PK`/`SK` because a `dynamodb:Attributes` condition that omits a
table's key attributes denies the request outright.

The projected read is still what `exists()` and `describe()` use, and now by
choice rather than by necessity: the capability map must not read a live key to
answer a yes/no, and keeping those two on that path is what keeps it exercised.
The Suppliers console needs the other half — *which fields* of a slot are
filled — which is derived from the value, so `describeFull`/`describeAllFull`
(`rest-api/src/credentials.js`) read the whole item. They still return only
booleans: `credentialStatus` derives them and discards the value. They degrade
to a blank status rather than throwing, so a build without the console's grant
sees "not set" instead of an exception.

The Gateway keeps synthesising journey reports (docs 20 §6.1) even though the
Lambda could now read `CRED#llm` in fact. The arrangement was right on its own
terms — the credential is used where the call is made — and reversing it to
follow a grant that widened for an unrelated reason would be the wrong lesson.

Rows written before the marker existed still read correctly: `credentialStatus`
falls back to the value when the row carries one, and — for a legacy row seen
through the projection, where there is by construction neither marker nor value
— treats the row's existence as the signal, which is what "configured" meant
before.

**Its own table, not a partition of an existing one.** Every other table here is
encrypted with the AWS-owned default key and walked by reset and export tooling,
and the gateway already reads several of them. A credential in one would be one
careless `Scan` away from a log.

**No `ttl`.** A credential that expired itself would take a live capability down
with nothing to say why.

**The previous value is not kept.** A rotation overwrites. An old credential is
not an audit record — it is a live key somebody could still use. What is kept is
the count, the time and the author.

### What stayed in Secrets Manager

| Secret | Read by | Contents |
|---|---|---|
| `kelabo/<env>/cookie-key` | Lambda, gateway | signs **all three token families** |
| `kelabo/<env>/api-origin` | Lambda; CloudFront at deploy time | the origin-check header value |
| `kelabo/<env>/oidc-google`, `…/oidc-apple` | Lambda | OIDC client secrets |

Every one is read at a cold start, compared against something, and never edited
by an operator — so there is no rotation story a console improves. The line is
*identity and perimeter stay in Secrets Manager; suppliers come here.* A
supplier key that leaks costs money and is rotated at the supplier; a cookie key
that leaks is every account in the deployment, and no rotation undoes the
sessions already minted with it.

Migration for an existing deployment: `make credentials-migrate env=<env>`
(dry by default, `write=1` to commit). The source secrets are never deleted.

---

## 6d. `config` table (operational configuration + the admin roster)

`kelabo-<env>-config`. Two partitions and nothing else. Full design: docs 23.

| PK | SK | Item |
|---|---|---|
| `OPCONFIG` | `V#000001` … | one published version of the operational configuration |
| `ADMIN` | `<lowercased email>` | one granted administrator — `grantedBy`, `at` |

**Its own table, not a partition of `kelabos`.** That would have been the
cheapest place to put it and is the wrong one: the kelabos table expires
partitions and is what a reset script walks. An operational configuration that
vanished with a TTL sweep would silently revert the whole deployment to its
bootstrap values, and the failure would look like a deploy nobody made.

**No `ttl` attribute at all, and PITR on.** Everything else here either expires
or is a credential; this is the deployment's own settings, and the only way to
lose a version should be an accident at the table level.

**Append-only, enforced by a condition and not by convention.** A publish is a
`PutItem` with `attribute_not_exists(PK) AND attribute_not_exists(SK)`. Two
administrators pressing Publish in the same second both computed the same next
version; without the condition the second would overwrite the first, losing a
change *and* the record of who made it. The loser gets `409 version_conflict`
and republishes against the new head.

**Six-digit zero-padded version in the sort key,** so a string sort is a version
sort — `V#000010` must not precede `V#000009`. The key is authoritative:
`parseOpConfig` reads the version from `SK` rather than trusting the `version`
attribute, so a row whose attribute drifted is still read correctly.

**The roster lives here because it exists only to say who may publish the
config.** Splitting them would put an access-control decision one table away
from the thing it controls, and a reader and a writer that disagreed about a
prefix would be a security bug rather than a lookup miss. `rootAdminEmail` is
*not* here — it is deployment config, deliberately, so that the one value
governing who may change everything else cannot itself be changed from a web
page (docs 23 §4).

**Two IAM shapes, and the asymmetry is the point.** The Lambda holds
`grantReadWriteData` — it publishes versions and maintains the roster. The
Gateway holds `dynamodb:Query` **fenced to `LeadingKeys = ["OPCONFIG"]`** with
`ForAllValues:` (without which a request naming several partitions passes if
*any* one matches), and no write of any kind. `Scan` is structurally impossible
there rather than merely withheld: it cannot be constrained by
`dynamodb:LeadingKeys` at all, so a Scan grant would hand the internet-facing
task the list of every identity that may reconfigure the deployment.

**One `DeleteItem`, and it is not a version.** The Lambda deletes a revoked
`ADMIN#` row — access control, not configuration, and root-only. Rolling a
setting back is publishing the old value again, which records that act too.

**No key material, ever.** This is an ordinary item with no customer-managed key
over it, in a table admin tooling scans and PITR copies. Supplier keys are §6c,
under their own CMK; there is not even a secret *name* here to point at one,
because the slot is the address.

**Read through a 60-second cache in each service** (`contracts/src/versioned.js`,
shared machinery). A read that fails keeps serving the last version read
successfully — never the seeded defaults, because a deployment that silently
reverted to bootstrap values mid-call is far harder to diagnose than one running
slightly stale settings. An empty partition is not a failure: it is a deployment
where nobody has published yet.

---

## 7. S3 archive bucket

- Key: `archives/<host>/<archiveId>.json` = full `Archive` object (transcript +
  board + minutes). Bypasses the 400KB item cap.
- BLOCK_ALL public, SSE, enforceSSL. Read by REST `GET /records/:archiveId`
  (after access check) and written by the Gateway on kelabo end.
- Lifecycle: optional Glacier transition per `retentionDays` policy (records are
  permanent by default; self-hoster may configure).

---

## 8. Access patterns → index used

| # | Access pattern | Table / index |
|---|----------------|---------------|
| 1 | Create kelabo | kelabos META, conditional put (no host guard — multiple live kelabos per host) |
| 2 | List active kelabos | kelabos `status-index` (status=active) |
| 3 | List my kelabos | `status-index` filtered by host, or participant companion |
| 4 | Load kelabo meta / header | kelabos `KELABO#<id> / META` |
| 5 | Append utterance | kelabos put `UTT#…` |
| 6 | Load rolling window (agent) | kelabos query `UTT#` desc, limit N |
| 7 | Append contribution | kelabos put `CONTRIB#…` |
| 8 | Load board (record) | kelabos query `CONTRIB#` (live) or S3 (archived) |
| 8b | **Board backfill** (late-comer/reconnect) | kelabos query `CONTRIB#` newest-N or `since` |
| 9 | Store/read minutes | kelabos `MINUTES` |
| 10 | Promote opencode session | kelabos `PROMOTION` |
| 11 | End kelabo (set status, ttl) | kelabos META update |
| 11b | List scheduled kelabos | kelabos `status-index` (`<tenant>#scheduled`) then filter to host-or-invitee |
| 11c | Who replied to an invitation | kelabos `PK = KELABO#<id>`, `begins_with(SK, "INVITE#")` |
| 11d | Autocomplete an invitee | users `tenant-index` (`tenantId`), `begins_with(email, <prefix>)` |
| 12 | Verify participant cookie | kelabos META participants[] contains identity |
| 13 | OTP request/verify + rate limit | otp `OTP#<email>`, `OTPIP#<ip>` |
| 13b | Refresh session (rotate) | refresh `RT#<id>` (verify hash, rotate chain) |
| 13c | Logout-all (revoke all devices) | refresh `identity-index` (identityHash) |
| 14 | User upsert / profile | users `USER#<email>` |
| 15 | List my records | history `participant-index` (participantIdentity) |
| 16 | Read a record | history `archiveId` → S3 `s3Key` (access check first) |
| 17 | Resolve MCP config | mcp `MCP#host#…` (`MCP#org` + `MCP#kelabo#…` reserved) |
| 18 | Session guard (promoted id) | kelabos `PROMOTION` (or in-proc Gateway cache) |
| 19 | Load journey detail / any sub-resource | journeys `JOURNEY#<id>` + SK prefix (`DESC#`, `REPORT#`, `TL#`, …) |
| 19b | Journeys in my tenant (list, public discovery) | journeys `tenant-status-index` (`<tenant>#<status>`) |
| 19c | Private journeys I can access | journeys `accessor-index` (`accessorIdentity`) |
| 19d | Which journeys is this kelabo in? (purge guard, "Part of:") | kelabos `KELABO#<id>`, `begins_with(SK, "JOURNEY#")` |
| 20 | Read the operational configuration (both services, 60 s cache) | config `PK = OPCONFIG` Query — never Scan; the Gateway's grant is fenced to this partition |
| 21 | Publish a configuration version | config conditional `PutItem` on `OPCONFIG`/`V#<n+1>` (§6d) |
| 22 | Is this caller an administrator? | config `PK = ADMIN` Query, plus the deploy-time `rootAdminEmail` |
| 23 | Grant / revoke an administrator | config `PutItem` / `DeleteItem` on `ADMIN`/`<email>` — root only |

---

## 9. Consistency & concurrency

- Utterance/contribution appends use monotonic SKs (`tStart`/`at` zero-padded +
  seq) to avoid collisions and keep chronological queries cheap.
- One-active-per-host uses a conditional write on META.
- The Gateway keeps hot connection state in-process; DynamoDB is the durable record,
  so a Gateway restart rebuilds from reconnects + DB, not from memory.

---

## 10. Tenant partitioning (reserved)

- `tenantId = <email domain>`. The `status-index` GSI is **already partitioned by
  `<tenantId>#<status>`**, so multi-domain active-kelabo listing is tenant-isolated
  with no reshape — self-host is just a single tenant.
- A multi-domain deployment would extend the same prefixing to history
  `participant-index`, mcp scopes, and (if desired) base-table PKs
  (`T#<tenant>#KELABO#<id>`) for hard isolation.
- Note: because tenant = domain, individuals on shared domains (e.g. gmail) share a
  tenant. Acceptable for now; explicit orgs/workspaces could refine this later.

---

## 11. Retention summary

| Data | Retention |
|------|-----------|
| live kelabo items | until `retentionDays` after end (TTL on the META item only — sibling `UTT#`/`CONTRIB#`/`MINUTES` rows are orphaned, no cascade; see the §2 warning) |
| OTP | ~10 min (TTL) |
| history rows | permanent |
| S3 archives | permanent (configurable lifecycle) |
| guest identities | ephemeral (cookie only) |
| journeys | permanent — no TTL attribute at all; deletion is always an explicit owner act (docs 20 §14) |
| supplier credentials | permanent — no TTL attribute at all; a rotation overwrites, and the previous value is not kept (§6c) |
| operational config + admin roster | permanent — no TTL attribute at all, deliberately: a sweep that removed a version would silently revert the deployment to its bootstrap values (§6d) |

`retentionDays` is itself publishable now (docs 23), with one asymmetry worth
stating here: it is **stamped on items as they are written**, so a change
reaches new material only. Lengthening it does not resurrect what has already
expired, and shortening it does not reach back to shorten what is already
stored.

Ephemeral-by-default posture for privacy (ARCHITECTURE §14.3): only registered
participants retain access; guests leave no durable identity.
