# 20 — Journey

Status: **implemented, short of what §17 marks permanently out of scope**
— 2026-08-22, extended 2026-08-26 with §12.3. Built: the data model (§4),
lifecycle/permissions (§3), health/progress (§5), reports (§6), the
message board (§7), documents (§8), the timeline (§9), contributor stats
(§10, both settling paths), the full REST API (§11), all three parts of
agent/MCP integration (§12.1 push, §12.2 pull, §12.3 direct journey
attachment + deep context pulls), and the SPA (§13, including the
"Part of: …" breadcrumb). Not built, and not planned in this document —
see §17: real file upload, an agent-triggered server-side report (§12.4,
by design), any wallet/billing scope, and the AI-suggested-status/
apply-status flow (§5/§6). Component docs
(01-spa, 02-rest-api, 03-gateway, 08-database, 09-data-flows,
10-data-contracts) now include Journey behaviour (updated 2026-08-25).

§6.1 records a correction made mid-implementation: the original draft put
report generation in rest-api and was wrong to. Read it if you are
tempted to route a new job through rest-api that calls the LLM — the
reasoning there is the general lesson, not just this one case's fix.

Depends on nothing that does not already exist on master. Adds one table,
one new item type on the existing `kelabos` table, a new REST module, a
handful of new SPA routes, one new system-prompt section, and a new
dev-mode MCP tool group. Adds no new auth primitive, no new cookie, no new
token family — `requireSession` and the existing `tenantId` derivation are
reused wholesale.

Per doc 19 §4 ("public repo = mechanism, private repo = policy"), this
document is mechanism only. Plan-based limits on how many journeys,
kelabos, documents or reports an account may have are policy, and are
designed separately, additively, on the `saas` branch
(`docs/saas/design-journey-quotas.md`) — nothing in this document should
grow a quota field just because a hosted plan wants one.

## 1. Concept

Two people finish a kickoff kelabo having made three decisions. Three weeks
later they start a follow-up kelabo — a new, unrelated `KELABO#<id>`
partition in the current data model, with no memory of the first one unless
a human re-types it. A **Journey** is the container that carries that
memory forward: a persistent, named object that links related kelabos
together, so that description, prior decisions, documents and a running
Q&A history are available — to the people in the room and to the agent
listening — the moment the second kelabo starts.

- **Cardinality is many-to-many.** A journey can link zero or more kelabos;
  a kelabo can belong to zero or more journeys. This is the one genuinely
  new relationship shape in the system — see §2.
- **A journey is not a folder of files.** It is a small set of
  purpose-built sub-resources (§4–§9): a versioned free-text description,
  optional health/progress indicators, on-demand Q&A reports, an optional
  pinned message board, and pasted text documents — each timelined (§9)
  and each readable by the agent (§12).
- **Relationship to `historyEnabled` (docs 05, 14).** A kelabo already has
  a cross-kelabo context mechanism: a host may opt a kelabo into reading
  the *host's own* past kelabo minutes (`gateway/src/agent/history.js`).
  Journey is the same *shape* of idea — inject a prior structured record
  into the system prompt, framed as past-not-present — but deliberate and
  curated (anyone can link any kelabo they participated in into a named,
  shared container) rather than automatic and host-scoped. The two are
  independent and additive: a kelabo can have `historyEnabled` on, be
  linked to a journey, both, or neither.

## 2. Where this fits the existing grain

Three facts shape every decision below, the same way doc 18 §1 opens with
the facts that shaped contacts/presence.

**Nothing in the system today groups kelabos, and nothing needs to change
to add it.** A kelabo's only "owner-shaped" field is `hostIdentity`, a bare
email string; there is no `teamId`, no `folderId`, no `seriesId`, nothing a
Journey would collide with. Every kelabo is, today, a fully isolated
partition. This is greenfield, not a retrofit.

**Visibility should reuse `tenantId`, not invent a second notion of
"org."** Doc 18 §1 already established that colleagues are *derived,
never stored* — "same org" means "same `tenantId`," computed from an email
domain, with no membership row anywhere (`users.tenant-index`). A public
journey's visibility rule is the identical derivation, reused wholesale: no
roster, no invite flow, just a `tenantId` match at read time.

**The existing `since`/`before` pagination split is a precedent, not a
free choice.** The board is read forward from a cursor (`since`, growing
tail); the transcript panel is read backward from a cursor (`before`,
loading further into the past on demand). A journey's timeline is
unbounded and read newest-first, which is the transcript shape, not the
board shape — §9.2 follows `before`/`limit`, not `since`/`limit`.

## 3. Lifecycle

### 3.1 Status

```
        create                 complete (owner)                delete (owner)
active ─────────► (usable) ────────────────────► completed ─────────────────► gone
                                        ▲              │
                                        └── reopen ─────┘ (owner)
```

No `draft` state, matching kelabo's own "born usable" convention. No
auto-expiry — deletion is always an explicit act (§14), never a TTL sweep.

**Completion freezes everything, no exception.** Once `completed`: no new
kelabo link/unlink, no description edit, no status update, no board
message, no document, no report. The journey is fully read-only until an
owner reopens it. This is a deliberate, simpler-than-necessary rule — it
would be easy to carve out "but reports are read-derived, allow those" —
kept out because a single "completed = frozen, full stop" rule is easier
to reason about and to explain in the UI than a list of exceptions.

### 3.2 Visibility and the access check

Every journey is `public` or `private`, owner's choice at creation,
changeable by the owner later.

- **Public** — every identity whose session `tenantId` matches the
  journey's `tenantId` has full read/write rights. Nothing is stored to
  grant this.
- **Private** — the owner maintains an explicit `ACCESSOR#<identity>`
  roster (§4.1). Being on it grants full rights, with one carve-out: an
  accessor cannot add or remove other accessors.

Access check order, computed fresh per request (no cached membership flag,
matching how host/participant checks already work on the `kelabos` table):

1. `identity === journey.ownerIdentity` → full rights, plus owner-only
   actions.
2. `journey.visibility === "public" && identity.tenantId ===
   journey.tenantId` → full rights.
3. `journey.visibility === "private"` → point-read `ACCESSOR#<identity>` →
   present ⇒ full rights (minus roster management); absent ⇒ 403.
4. Else → 403.

Guests never satisfy (2) or (3): a guest identity carries no email domain
to match a `tenantId`, and a guest is never added as an accessor — nothing
here needs a special guest rule, it falls out of the identity shape.

### 3.3 Permission matrix

| Action | Public member / Private accessor | Owner |
|---|---|---|
| View, search, read timeline | yes | yes |
| Edit description | yes | yes |
| Set health/progress (§5) | yes | yes |
| Add/edit/unarchive board message | yes | yes |
| Archive a board message | poster only | yes |
| Add document | yes | yes |
| Remove a document | poster only | yes |
| Link a kelabo (must be host/participant of *that* kelabo) | yes | yes |
| Unlink a kelabo | yes | yes |
| Request a report | yes | yes |
| Manage the accessor roster (private only) | no | yes |
| Toggle visibility | no | yes |
| Mark complete / reopen | no | yes |
| Update avatar | no | yes |
| Delete journey | no | yes |
| Transfer ownership | no | yes |

The right column's items are all either irreversible (delete), large
blast-radius (complete freezes every other member's access to write), or
identity-defining (visibility, ownership) — kept owner-only even though a
stricter reading of "full rights" could extend further.

## 4. Data model

### 4.1 New table: `kelabo-<env>-journeys`

One partition per journey, `PK = JOURNEY#<journeyId>`. Same physical
conventions as `kelabos` — PAY_PER_REQUEST, PITR on. Unlike `kelabos`,
**no `ttl` attribute is declared** — a journey is long-lived by nature and
never auto-expires; every removal in this document is an explicit write.

| SK | Item | Fields |
|---|---|---|
| `META` | Root | `journeyId, title, visibility, status, ownerIdentity, tenantId, tenantStatus (=tenantId#status), avatarVariant, health?, progress?, currentStatusVersion?, currentDescriptionVersion, counts:{kelaboCount, documentCount, reportCount, boardMessageCount, accessorCount}, createdAt, updatedAt, completedAt?, completedBy?, reopenedAt?` |
| `DESC#<pad(version,6)>` | Description version (immutable) | `version, markdown, editedBy, editedAt, changeNote?` |
| `STATUS#<pad(version,6)>` | Health/progress snapshot (immutable) — §5 | `version, health, progress, note?, setBy, setAt, source, reportId?` |
| `ACCESSOR#<identity>` | Private-journey roster entry | `identity, displayName, avatarVariant, addedBy, addedAt` |
| `LINK#<kelaboId>` | Kelabo membership (forward) | `kelaboId, titleSnapshot, hostIdentitySnapshot, linkedBy, linkedAt, statusSnapshot` |
| `REPORT#<reportId>` | One report, append-only — §6 | `reportId, question, requestedBy, requestedAt, status(pending\|ready\|failed), answer?, generatedAt?, error?` |
| `BOARDMSG#<msgId>` | Board message, current head — §7 | `msgId, content, createdBy, createdAt, updatedBy?, updatedAt?, version, archived, archivedBy?, archivedAt?` |
| `BOARDMSG#<msgId>#V#<pad(version,6)>` | Board message version | `msgId, version, content, action(created\|edited\|archived\|unarchived), actor, at` |
| `DOC#<docId>` | Document, current head — §8 | `docId, title, content \| s3Key+excerpt, sizeBytes, addedBy, addedAt, removed, removedBy?, removedAt?` |
| `CONTRIBUTOR#<identity>` | Per-person rollup — §10 | `contributorIdentity, kelaboJoinCount, reportRequestCount, firstSeenAt, lastActiveAt` |
| `TL#<pad(at,13)>#<rand6>` | Timeline projection row — §9 | `type, refSk, summary, actor, at` |
| `SETTLED#<kelaboId>` | `kelaboJoinCount` idempotency marker — §10 | `kelaboId, settledAt` — no reader; exists only so `archive.js`'s hook is safe to call twice |

Sort-key padding follows the existing convention exactly: `at` values are
zero-padded to 13 digits before being embedded in a sort key, the same
width `CONTRIB_KEY_WIDTH` already uses (`rest-api/src/db.js:13-21,20`), for
the same reason — a numeric-looking prefix must sort correctly as a
string. The 6-char random suffix on `TL#` rows is a same-millisecond
tie-breaker only, `Math.random().toString(36)`, matching
`gateway/src/db.js:16` — not a secret, not an identity.

Every mutating write updates its own item **and** writes one `TL#` row, in
the same call, so the timeline is a genuine index rather than something
that can drift out of sync with the six item types it summarizes.

### 4.2 GSIs

| GSI | PK | SK | Purpose |
|---|---|---|---|
| `tenant-status-index` | `tenantStatus` | `updatedAt` | "Journeys in my tenant" — public-journey discovery, filtering `visibility` in code after the query, the same "query broad, filter in the handler" idiom `listKelabosByStatusForIdentity` already uses against `kelabos.status-index` |
| `accessor-index` | `identity` | `addedAt` | "Private journeys I'm an accessor of" — a direct structural copy of `invitee-index` (`infra/lib/dynamodb-stack.js:35-48`, queried at `rest-api/src/db.js:306-316`) |

### 4.3 One new item type on the existing `kelabos` table

`PK = KELABO#<kelaboId>`, `SK = JOURNEY#<journeyId>` →
`{journeyId, journeyTitleSnapshot, journeyVisibilitySnapshot, linkedAt, linkedBy}`.

```
   kelabos table                          journeys table
 ┌───────────────────────┐              ┌───────────────────────┐
 │ KELABO#<id>           │              │ JOURNEY#<jid>         │
 │  META                 │              │  META                 │
 │  UTT# ...             │   mirrored   │  LINK#<id> ───────────┼──► forward
 │  CONTRIB# ...         │◄─────────────┤                       │
 │  MINUTES              │  membership  │  DESC#, STATUS#,      │
 │  JOURNEY#<jid> ───────┼──────────────┼─►REPORT#, BOARDMSG#,  │
 │                       │   backward   │  DOC#, TL#, ...       │
 └───────────────────────┘              └───────────────────────┘
```

This mirror exists so two questions are cheap **without a new GSI and
without a cross-table scan**:

1. *Does this kelabo belong to any journey?* —
   `begins_with(SK, "JOURNEY#")` on the kelabo's own partition. This is
   the purge guard, §14.3.
2. *Which journeys is this kelabo part of?* — the same query, used to
   render a "Part of: …" banner wherever kelabo META is already fetched.

Both the `journeys`-table write and this mirror are written in **one
`TransactWriteItems`** together with a condition that the journey is not
`completed` and an `ADD kelaboCount 1` on META. DynamoDB transactions may
span multiple tables within one account/region — this needs no new
capability, only using an existing one across a second table.

### 4.4 IDs

`journeyId`, `reportId`, `msgId`, `docId` are all `crypto.randomUUID()`,
matching the existing rule: cryptographic randomness for anything that is
an identity, `Math.random()` only for the non-secret sort-key
tie-breaker.

## 5. Status indicators: health and progress

Optional, unset (`null`) until someone sets them — "optional" means
genuinely absent, not defaulted to `0%` / red.

- **`health`**: `"green" | "yellow" | "red" | null`.
- **`progress`**: integer `0`–`100`, or `null`.

Each update writes one `STATUS#<version>` snapshot holding both fields
together (people report health and progress together — "60%, yellow,
because X" — not as two independently-drifting numbers) plus an optional
free-text `note`. An update may be partial; an omitted field carries its
previous value forward into the new snapshot. Either field can be
explicitly set back to `null`.

Same permission tier as editing the description (§3.3) — content, not a
structural action — and frozen once the journey is `completed` (§3.1).

**The UI reuses the existing fixed semantic colors, not new ones.**
`--success` / `--warn` / `--danger` (`kelabo.css:117-122`, dark-mode
overrides `:130-133`) are already documented as independent of the
`data-scheme` picker specifically so danger/warn/success never shift
meaning — green/yellow/red maps onto them directly rather than inventing a
parallel palette.

**Not built in this pass:** a report proposing `suggestedHealth`/
`suggestedProgress` and a member applying it via
`POST /journeys/:id/reports/:reportId/apply-status`. The reasoning for why
it should stay a proposal a human applies, never something the LLM writes
directly, is unchanged from the original design — an LLM silently changing
a visible project-health signal is the wrong trust boundary — this is
scope not yet built, not a decision reversed.

## 6. Reports

`POST /journeys/:id/reports {question}` — a member asks a free-text
question; the answer is generated once, synchronously, and stored forever
alongside the question that produced it (never overwritten — contrast
with kelabo's own `MINUTES` item, which is a single unversioned slot; a
journey report is append-only by design because the running history of
what was asked and answered *is* the value).

### 6.1 Why this runs in the Gateway after all — a correction made while building it

The first draft of this section argued the opposite: that a journey report
needs none of what makes kelabo minutes generation Gateway-resident (a
warm resident transcript, sub-agent dispatch, the dev-tunnel), so it should
run as a plain control-plane job in rest-api's Lambda. That reasoning about
*what the job needs* is still correct — but it missed a harder constraint
discovered while implementing it: **the LLM credential itself is not
readable from rest-api, by design.** `infra/lib/lambda-stack.js` grants the
REST API's role enough to answer "is the assistant configured at all" for
the capability map (docs 19 §3) and no more. Only
`infra/lib/gateway-ecs-stack.js` grants a role that can read the key
itself, to the Gateway's task.

Under Secrets Manager that was one statement holding
`secretsmanager:DescribeSecret` and never `GetSecretValue`. Since the
supplier keys moved to DynamoDB (docs 08 §6c) it is the same asymmetry
expressed in that table's terms, because "does the item exist" and "what
is in it" are otherwise the same `GetItem`:

- `CRED#stt` and `CRED#mail` — the two slots whose **values** the control
  plane legitimately uses (minting a browser transcription credential,
  sending mail) — are granted as plain whole-item `GetItem`.
- `CRED#llm` and `CRED#rtc` are granted `GetItem` fenced by
  `dynamodb:Attributes` (`ForAllValues:StringEquals`, the frozen
  `CREDENTIAL_STATUS_ATTRS` list from `contracts/src/credentials.js`) plus
  `dynamodb:Select = SPECIFIC_ATTRIBUTES`. That list is the row minus its
  `value`, and it carries a non-secret `configured` marker written beside
  the credential — so the question is answerable and the answer is not the
  key. An attribute-scoped `GetItem` is `DescribeSecret`; an unscoped one
  is `GetSecretValue`; a whole-item read of `CRED#llm` from this role is
  AccessDenied.

The Lambda holds no `PutItem` on that table at all: master has no
credential-write route, and the operator scripts that write one run under
the operator's own AWS credentials. (The private SaaS branch has a
root-only credential reveal console and widens this grant on its own side;
the split is deliberate.)

Giving rest-api its own readable copy of the same credential would work
mechanically, but it would be re-opening a boundary this codebase drew on
purpose — the LLM key's blast radius is deliberately confined to one
component. So generation still happens in the Gateway, reusing
`gateway/src/agent/llm.js` directly (no `contracts/` extraction needed: it
already has zero internal dependencies, and both the existing agent code
and this new code live in the same package, so there is nothing to share
across a package boundary in the first place). The call reaches it through
the **existing** rest-api → Gateway internal-request direction —
`POST /internal/journeys/:id/report`, alongside the `end`/`minutes`/
`cancel`/`reschedule` actions already dispatched that way
(`gateway/src/server.js`) — not a new direction invented for this.

Concretely: `POST /journeys/:id/reports` (rest-api) creates the pending
row, counts the ask (§10), and *awaits* `internal.requestJourneyReport`
the same way `requestMinutes` is awaited; the Gateway's handler
(`gateway/src/journeys.js`, `generateJourneyReport`) reads the journey's
own context directly from the `journeys` table (new read+write grant on
`gateway-ecs-stack.js`, alongside its existing `kelabos`/`history` access),
calls the LLM, and writes the finished row back — `ready` with an answer,
or `failed` with a reason, always one or the other, never left `pending`
forever. rest-api's own response carries only `{reportId, status}`; the
client re-fetches the finished row via `GET`, the same "a mutating call
returns a summary, a follow-up GET returns the resource" shape every other
create endpoint in this document already uses. If rest-api cannot reach
the Gateway at all, it marks the row `failed: gateway_unreachable` itself
— the one failure mode the Gateway's own handler can never observe.

### 6.2 Context assembly and size discipline

The existing pipeline enforces **no size limit** on what it feeds an LLM
today — the main-agent thread and the minutes prompt both grow unbounded
(`runner.js:121-127`'s own comment: "no limit... the entire history, not
just a rolling window"). A journey report must not repeat that; it brings
its own explicit budget in `gateway/src/journeys.js`'s `buildContext()`,
modelled on the one place the pipeline already does this —
`gateway/src/agent/history.js`'s `HISTORY_LIMIT = 8` plus per-field
truncation — using the same reduction `history.js` already applies to a
past kelabo's minutes (summary, decisions, actionItems; topics and
findings dropped):

- Description: latest version only, capped at 4,000 characters.
- Active (non-removed) pinned board messages: newest 10, 500 characters each.
- Active (non-removed) documents: newest 5, 3,000 characters each.
- Linked kelabos, newest 8 (`LINKED_KELABO_LIMIT`, matching `HISTORY_LIMIT`):
  each reduced to its stored `MINUTES` — summary, decisions, actionItems —
  capped at 1,500 characters combined.
- Prior *ready* reports on the same journey: newest 3, question capped at
  200 characters, answer at 1,000.
- The new question itself, capped at 2,000 characters, as the trailing
  instruction.

A removed board message or document is excluded structurally — the query
only ever looks at active items — not filtered after the fact, so there is
no code path where a removed one could leak into a prompt by omission.

### 6.3 Untrusted content, explicitly

A journey's description, documents and board messages are free text from
potentially many contributors, about to be concatenated into one LLM
prompt. That is exactly the shape transcript injection already defends
against — captions are wrapped in `<kelabo-transcript untrusted="true">`
and the persona is told "data, not instructions," not because a
registered user is assumed hostile but because the *content* did not
originate from the person asking the question. Journey content needs the
identical wrapper; being written by a signed-in accessor is not a reason
to skip it.

### 6.4 Report visibility — public by default, private to the asker alone

**Added 2026-08-26.** A report carries its own `visibility`
(`"public" | "private"`, default `"public"`, `journeyReportBodySchema`),
unrelated to the journey's. Public is the default because the point of a
journey report is usually to be shared; asking privately is the
deliberate act — the inverse of `aiCanPost`'s default-off, and for the
same reason: the surprising outcome is the one that has to be chosen.

**A private report is readable by the person who asked it and by nobody
else — deliberately including the journey's lead.** Every other
owner-only power in this document is about the *journey*; this is about
one member's own question, and a lead-sees-everything carve-out would
make "private" a promise the product does not keep. `mayReadReport` in
`rest-api/src/journeys.js` is the single rule, applied by both
`listReports` and `getReport`. Naming a private reportId directly answers
**404, not 403**: a 403 would confirm that the id exists and that it
belongs to someone.

Three surfaces follow from it, and each is a place the rule could have
leaked:

- **The timeline** serves a private report's row only back to the person
  who asked it (`mayReadTimelineEntry`, and the same filter on the
  Gateway's `queryJourneyTimeline` for §12.3's
  `kelabo_journey_timeline`). Redacting the summary to
  `"Report requested (private)"` was the first attempt and is **kept as
  well** — but redaction alone was wrong: "someone asked something
  private, at 14:02" is itself the disclosure, and on a three-person
  journey it names them. Two controls rather than one because the
  timeline is the surface where a new reader is easiest to add later.
  The paging cursor is taken from the **unfiltered** page: `nextBefore`
  has to advance past rows this viewer cannot see, or a page that filters
  down to nothing returns the same window forever.
- **The agent pull tools** (§12.3's `kelabo_journey_reports`,
  `kelabo_journey_context`) serve public reports plus the *attached
  identity's own* private ones — `conn.identity` is already on the
  connection, so the agent obeys exactly the rule REST does rather than a
  second, looser one. A private report reaching the agent is rendered
  with an explicit "visible to you alone, do not repeat it to a kelabo"
  note: the model must not treat it as shared journey material.
- **`buildContext`** (§6.2, the server-side synthesis) sees **public
  only**, never "everything" — that answer is itself readable by whoever
  asks next, so folding a private report into it would launder one
  member's private question into a shared one. This is why
  `listReadyReports` takes an explicit `viewer` that defaults to *null*
  meaning public-only, rather than defaulting to unrestricted.

An agent-submitted report (§12.2's `kelabo_journey_report_submit`) writes
`visibility: "public"` explicitly rather than leaving it unset: a
synthesis submitted to be shared should not be indistinguishable from one
whose author meant it to be private.

### 6.5 The metering seam — two optional calls, no billing on master

A journey question is the one LLM call in this system that belongs to no
kelabo, so none of the existing per-call accounting reaches it. Master
carries no billing and never will (doc 19 §4), but it must not make
billing *impossible* downstream either — a hosted deployment that cannot
account for this spend has to fork the whole report pipeline to add two
lines.

So `generateJourneyReport` calls two optional hooks on the container:

- `c.usage?.allowJourneyReport?.(journeyId, { identity, meta })` — before
  the spend. A `{ ok: false, reason }` marks the report failed with that
  reason and **never calls the provider**; anything else proceeds. Refusing
  after the money is spent would be theatre.
- `c.usage?.noteJourneyReport?.(journeyId, { reportId, identity, usage, meta })`
  — after it, wrapped so a meter that throws cannot turn a generated
  answer into a failed report. The spend already happened and the reader
  is owed the answer.

`c.usage` does not exist in this repository's container, so both are
no-ops here and the self-hosted behaviour is exactly what it was.

Two supporting changes make the hooks worth having. The internal route
passes `identity` (`payload.sub` from the internal JWT — the person who
asked, already verified, previously discarded at the route). And the call
uses **`llm.completeRaw`** rather than `llm.complete`: they are the same
request, but `complete` returns only the text and drops the provider's own
usage record, which is the only trustworthy token count in the system —
the agent pipeline already reports that same normalized shape
(`agent/llm.js`). There is no local tokenizer here and there should not
be one.

## 7. Message board

A small set of pinned, mutable messages — distinct from a kelabo's own
board (`CONTRIB#` rows, which are fanned-out and never edited). A journey
message is edited in place, but every edit is kept: the
`BOARDMSG#<msgId>` item is the current head, `BOARDMSG#<msgId>#V#<version>`
items are the immutable chain behind it, mirroring `DESC#`/`STATUS#`
versioning.

Removal is soft and reversible, called **archiving**, not deletion — a
deliberate departure from documents' one-way removal (§8.2), corrected
after building it once the other way. `archived:true`/`archivedBy`/
`archivedAt` go on the head; the version chain up to that point stays
intact and readable regardless. **Nothing about an archived message can
be edited until it is unarchived** — `POST .../unarchive` clears
`archivedBy`/`archivedAt` (stale once no longer true) and restores
editing, keeping the full fact of every past archive/unarchive in the
version chain (`action: "archived"|"unarchived"`) either way.
`boardMessageCount` on META is bidirectional: it drops on archive and
rises again on unarchive, always reflecting the current, visible count.

Archiving is narrower than the general write access §3.3 grants every
member: only the message's own poster (`createdBy`) or the journey's lead
(`ownerIdentity`) may archive it — `403 not_message_author_or_lead`
otherwise. Add/edit/unarchive stay open to every member; only the
removal-shaped action is restricted, the same reasoning as documents
(§8.2).

Archiving means "no longer important, not outstanding — not gone." The
SPA hides an archived message from the board's default view and offers
to reveal it (a "Show archived (N)" toggle), showing its real content
when revealed rather than a placeholder — there is nothing secret about
it. `POST .../board/:msgId/archive` and `.../unarchive` are state
transitions, not deletions, the same reason `/journeys/:id/complete` and
`/journeys/:id/reopen` are `POST`, not `DELETE`.

`aiCanPost` (META boolean, default off, owner-controlled) gates whether an
attached agent may write to the board on its own initiative
(`kelabo_journey_post`, §12.2) — independent of human write rights. This
mirrors `historyEnabled`'s own justification for defaulting off: a
human-curated, always-visible surface being edited unsupervised by an
agent is a decision an owner has to actually make, not a default. Set via
`PATCH /journeys/:id`, surfaced in the SPA as an owner-only "Assistant can
post to the board" switch on the detail page's Overview tab (added
2026-08-26 — the flag shipped API-only at first, which made it a setting
nobody could find) — read-only but visible to every member, the same
disclosure rule `historyEnabled` follows.

## 8. Documents

Pasted or typed text (title + markdown body) — not file upload. There is
no upload capability anywhere in this codebase today (avatars are
generated, never uploaded, §13); building presigned-upload, size/type
validation and a new bucket for arbitrary binary attachments is a
materially larger, separate piece of work than this document covers, and
nothing here blocks adding it later behind the same `DOC#` item shape.

### 8.1 Inline vs. S3 overflow

Same split the kelabo archive already uses for the 400KB DynamoDB item
cap: content that fits stays inline on the `DOC#<docId>` item; content
over the threshold is written to S3 with the item holding a pointer
(`s3Key`) plus a short excerpt for cheap listing — the identical shape as
`archives/<host>/<archiveId>.json`, just a different bucket or prefix.

### 8.2 Removal

Soft-delete: `removed:true` + timestamp on the head. "Files can be
removed, but the record can't be changed" — once removed, that document's
timeline entry is permanent and its content is excluded from future
report/agent context assembly; there is no un-remove and no further edit.
A document someone wants back is re-added as a new one.

Narrower than the general write access §3.3 grants every member: only the
document's own poster (`addedBy`) or the journey's lead (`ownerIdentity`)
may remove it — `403 not_document_owner_or_lead` otherwise. Adding stays
open to every member; only removal is restricted, the same reasoning as
board messages (§7).

## 9. Timeline

### 9.1 The projection row

Every mutation across §4–§8 writes one `TL#<pad(at,13)>#<rand6>` row
alongside its own item, `type` one of
`description | status | kelabo_linked | kelabo_unlinked | report |
board_message | document`. Reading the timeline is one query against this
prefix, never a fan-out union across six item types.

A `board_message` entry's `summary` carries the message's own content
(clipped to 80 characters, no ellipsis — the same convention `report`
entries already use for their question), not a content-free label —
`Message added: <content>` / `edited:` / `archived:` / `unarchived:`.
`detail.action` on the same entry is one of those four words, matching
the version chain's own `action` field exactly.

### 9.2 Pagination

`GET /journeys/:id/timeline?type=&before=&limit=` — backward cursor
(`before`), matching `/caption/history`'s convention (§2), not the
board's forward `since`: a journey's timeline is read newest-first and
grows without bound, the same shape a long-running transcript already
has, unlike a kelabo's own list endpoints (`/kelabos`, `/records`), which
return everything unbounded today because a person's own kelabo/record
count stays small. A journey's timeline has no such ceiling, so it gets
the one real cursor precedent that already handles unbounded, backward-read
history.

### 9.3 Type filters

Chips over the same enum as `type` above, rendered as day-divider
sections (reusing `annotateDays`, `spa/src/time.js:67-81`) and type-coded
compact cards (reusing the `ContributionCard` shape: an icon + border
color per type, click-to-expand body).

## 10. Contributor stats

Shown on the journey's overview: creator, and per person, a
**kelabo-join count** and a **report-request count** — a
`CONTRIBUTOR#<identity>` rollup row per person, maintained by
unconditional `ADD` at write time, never by scanning at read time. A
rollup answers a question asked on every page load; deriving it fresh by
re-scanning every linked kelabo's history on every load would make the
cheapest page the most expensive one as a journey grows.

- **`reportRequestCount`** — `ADD 1` on the requester's row at report
  creation. Counts every request, including ones that later fail — the
  count is about the act of asking.
- **`kelaboJoinCount`** — settles when a linked kelabo's participant list
  is final. Two ways that can happen, both built:
  - Linking an *already-ended* kelabo settles immediately —
    `linkKelabo` reads the `history` row's `participantIdentities` and
    bumps each one, rest-api-side, using the same `db.getHistory` records.js
    already calls.
  - A kelabo linked while still *live*, which later ends, settles in
    `gateway/src/archive.js`'s `endKelabo` — once the transcript/board are
    archived, it looks up every `JOURNEY#` mirror row on the ending
    kelabo's own partition (the same query §12.1's push context already
    uses) and calls a new `settleKelaboJoin()` export in
    `gateway/src/journeys.js` for each. Independent of whether the
    history/archive write itself succeeded: a journey's roster reflects
    the kelabo having happened either way.

  **Idempotent against `endKelabo`'s own retry machinery.**
  `putHistoryRow`/`putParticipantIndex` are safe to redo on a resumed end
  (`archivePending`/`resuming`, §"how a kelabo ends") because they are
  unconditional overwrites; an unconditional `ADD` is not. `settleKelaboJoin`
  writes a `SETTLED#<kelaboId>` marker on the journey with
  `attribute_not_exists(SK)` before bumping anyone, so a resumed end that
  reaches this a second time for the same kelabo finds the marker and
  bumps nobody twice. This marker has no reader of its own — it exists
  purely so this hook can be called more than once safely — and is the one
  item type in §4.1's table added since that section was first written.
  Guests are included in the bump, matching the already-built
  already-ended path exactly (`history.participantIdentities` is every
  participant, not just non-guests — the guest-exclusion in `archive.js`
  is specific to `putParticipantIndex`'s own fan-out, a different concern).
- **Unlinking a kelabo never decrements anything.** The rollup is a
  cumulative record of contribution to the journey, not a live membership
  count — the same reasoning that keeps `kelabo_unlinked` a recorded
  timeline event rather than an erasure of the fact that the link once
  existed.

## 11. REST API

New `rest-api/src/journeys.js`, same `createApp(deps)` factory convention
as `kelabos.js`/`records.js`.

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/journeys` | session | Create `{title, description?, visibility}` |
| GET | `/journeys` | session | `{mine, accessible, public}` |
| GET | `/journeys/:id` | §3.2 | Detail, counts, description head, `myRole` |
| PATCH | `/journeys/:id` | owner | title / visibility |
| POST | `/journeys/:id/complete` \| `/reopen` | owner | Status flip |
| DELETE | `/journeys/:id` | owner | Cascading delete, §14.1 |
| GET/POST/DELETE | `/journeys/:id/accessors[/:identity]` | member (read) / owner (write) | Private roster |
| POST | `/journeys/:id/kelabos` | member, host/participant of target | Link `{kelaboId}` |
| DELETE | `/journeys/:id/kelabos/:kelaboId` | member | Unlink |
| GET | `/journeys/:id/kelabos` | member | Linked list, live status |
| POST | `/journeys/:id/description` | member | New version `{markdown, changeNote?}` |
| GET | `/journeys/:id/description/history` | member | Version list |
| POST | `/journeys/:id/status` | member | `{health?, progress?, note?}` — §5 |
| GET | `/journeys/:id/status/history` | member | Version list |
| GET/POST/PATCH | `/journeys/:id/board[/:msgId]` | member | Pinned messages — §7 |
| POST | `/journeys/:id/board/:msgId/archive` | member | Hide by default, reversible — §7 |
| POST | `/journeys/:id/board/:msgId/unarchive` | member | Reverse of the above |
| GET | `/journeys/:id/board/:msgId/history` | member | Version list |
| GET/POST/DELETE | `/journeys/:id/documents[/:docId]` | member | §8 |
| POST | `/journeys/:id/reports` | member | `{question}` → synchronous report — §6 |
| GET | `/journeys/:id/reports[/:reportId]` | member | List / one |
| POST | `/journeys/:id/reports/:reportId/apply-status` | member | Apply a suggested health/progress — §5 *(designed, not built — §17)* |
| GET | `/journeys/:id/timeline?type=&before=&limit=` | §3.2 | §9.2 |
| GET | `/journeys/search?q=` | session | Title pass over discovery, then a capped pass over description + live board messages. Same shape as `/records/search` **minus its cache**: an archive is immutable and a journey's body is not, so caching it would serve a description somebody edited ten minutes ago. Cap is correspondingly tighter (20), and the body pass is a Query rather than an S3 GET. Answers `{results, bodyCapped}` |

Touch-ups to existing endpoints:

- `POST /kelabos` / `POST /kelabos/schedule` bodies gain optional
  `journeyIds: string[]` — "created under a journey."
- `GET /kelabos/:id` (and `/scheduled`) responses gain
  `journeys: [{id, title, visibility}]`.
- `DELETE /records/:archiveId`, **host-purge outcome only**: 409
  `kelabo_in_journey` while the kelabo carries a `JOURNEY#` mirror whose
  journey still **exists and is live** (§14.3). A mirror whose journey is
  gone — or whose META is a phantom (no `ownerIdentity`/`status`, the trace
  of an unguarded UpdateItem racing `deleteJourney`) — is treated as no link
  and tidied in passing, so a stale mirror can never block a purge forever.
  The participant-only "drop from my list" outcome is untouched, because it
  never destroys anything a journey depends on.

## 12. Agent / MCP integration

Two independent mechanisms, matching the existing push (`historyEnabled`)
vs. pull (`kelabo_history` tool) split.

### 12.1 Push — system-prompt injection — **built**

`gateway/src/agent/journeyContext.js`, sibling to `history.js`, called
from `runner.js`'s `ensureContext()` — always attempted, no opt-in flag,
because linking a kelabo into a journey is already the deliberate,
visible act `historyEnabled` exists to gate for a fully automatic record.

**Supersedes `historyEnabled` rather than joining it.** The two used to
load independently — a kelabo could have both, on the reasoning that
plausibly wanting both is not the same as one making the other pointless.
In practice a journey already *is* the narrower, deliberately-linked
version of the same continuity `historyEnabled` provides more diffusely,
and holding both in the prompt at once serves nobody. `journeyContext.js`
exports `historyStillApplies(meta, journeys)` — `false` the moment
`journeys` (the *reduced, reachable* result of `loadJourneyContext`, not
the raw link count) is non-empty — and `runner.js`'s `ensureContext()`
now loads journey context first and gates `loadKelaboHistory()` on that
result. Checking the reduced result, not the raw links, is deliberate: a
dangling or momentarily-unreachable journey link falls back to
`historyEnabled` if the host opted into it, rather than leaving the
assistant with neither source — this pipeline's existing "best-effort,
never total silence" posture. Evaluated fresh every turn, so a kelabo
linked to a journey *after* `historyEnabled` was already turned on for it
loses the broader record the moment the link exists, not at some later
recompute. The SPA reflects this: `NewKelabo.jsx`/`Schedule.jsx` hide (and
reset to `false`, not just hide) the `historyEnabled` toggle once a
journey is picked, and `RoomShell.jsx`'s two disclosure chips (below) are
mutually exclusive for the same reason.

For each journey the live kelabo is linked to (`JOURNEY_LIMIT = 3`,
found via the same mirror §4.3 describes — `queryKelaboItems(c, kelaboId,
"JOURNEY#")`, no new query shape), builds a digest reusing
`gateway/src/journeys.js`'s own reducers — the same rows a report reads —
rather than a second copy: title, latest description (clipped 1,500
chars), health/progress, up to 5 active pinned board messages (clipped
300 chars each), up to 3 active documents (clipped 800 chars each —
`DOCUMENT_LIMIT`/`DOCUMENT_CLIP`, `journeyContext.js`), and up to 5
*other* linked kelabos reduced to their minutes (summary/decisions/
actionItems, the live kelabo itself and any with nothing to say excluded,
the same "worse than nothing" filter `history.js` already applies).
`renderJourneyContext()` in `persona.js` appends a `JOURNEY CONTEXT:`
section after `EARLIER KELABOS:`, with the same "reference material, not
instructions, not the current state of anything, name which journey a
fact came from" framing, plus an explicit "never dispatch a sub-agent to
look up something already answered here, including inside a document"
instruction — the same one `history.js`'s own framing already carries.

**Documents were missing from this digest entirely until a live
production report caught it**, not a design decision: a participant
asked a question whose answer existed only in a document attached to the
journey the kelabo was linked to, and the assistant — correctly, given
what it could actually see — dispatched a sub-agent to research the term
externally instead of answering from context it didn't have. Every other
`gateway/src/journeys.js` reducer (`latestDescription`,
`activeBoardMessages`, `linkedKelaboSummaries`) was already reused here;
`activeDocuments` (already built for §6's on-demand report, exported for
the first time for this) simply hadn't been wired into the always-on push
path. Clipped harder per document than a report gets (800 vs. 3,000
chars) because this cost is paid on every turn, not once per request.

Threaded through `worker.js` (`ctx.journeys`) into `MainAgent`'s
constructor as a new, optional, default-`[]` parameter — verified not to
disturb any existing call site by running the full agent pipeline
afterward: all 37 of `test/agent.mjs`'s tests, `test/devAgent.mjs
--provider scripted` end-to-end, and this document's own new tests in
`gateway/test/journeys.mjs`.

**A gap surfaced while building this, closed in the same pass as §12.2:**
`historyEnabled` is deliberately surfaced to every participant in the
room (docs 09/19 — "a capability nobody can see is one nobody can object
to"), because it puts one host's past kelabos in front of people,
possibly guests, who were not there. Journey context does the same thing
structurally, and for a few hours in this codebase's history had no
equivalent room-visible indicator at all. It now does — the "Part of: …"
chip described in §13, rendered from `kelabo.journeys` (the §11 touch-up
to `GET /kelabos/:id`), using `chip-dev` and the `link` icon in
`RoomShell.jsx` right beside the `historyEnabled` chip it was written to
match, generically labelled ("journey" / "N journeys", never the titles
themselves, which the tooltip carries instead) so a long title cannot
blow out the room's single-line identity strip.

### 12.2 Pull — dev-mode MCP tools — **built**

Five new tools alongside the existing eight (`kelabo_join`, `kelabo_post`,
`kelabo_working`, `kelabo_info`, `kelabo_board`, `kelabo_history`,
`kelabo_minutes`, `kelabo_leave`), served over five new KAP frame pairs in
`gateway/src/tunnel.js`. Read paths call straight into
`gateway/src/journeys.js`'s existing reducers (`getJourneyMeta`,
`latestDescription`, `activeBoardMessages` — the same rows a report
reads); the two writes are new exports there
(`submitJourneyReport`/`postJourneyBoardMessage`), independently
implemented rather than shared with rest-api's own
`requestReport`/`addBoardMessage`, the same dual-access pattern `kelabos`
already has between the two packages:

| Tool | Purpose |
|---|---|
| `kelabo_journey_info({journeyId?})` | Title/visibility/status/description/health/progress/counts |
| `kelabo_journey_timeline({journeyId?, entryType?, before?, limit?})` | §9.2, over the tunnel |
| `kelabo_journey_board({journeyId?})` | Current pinned messages |
| `kelabo_journey_report_submit({journeyId?, question, answer})` | The agent's own synthesis, stored directly — no LLM round-trip |
| `kelabo_journey_post({journeyId?, content, msgId?})` | Write/edit a board message, gated by `aiCanPost` (§7) |

Two things changed from the original plan while building this, both
recorded here rather than silently:

- **Every tool gained an optional `journeyId`.** The original signatures
  carried none, on the unstated assumption of one journey per kelabo —
  which does not hold (§4.3's mirror has no such cap; `JOURNEY_LIMIT = 3`
  in §12.1 only bounds the *prompt*). Omitting it resolves against the
  kelabo's own links (`resolveJourneyForKelabo` in
  `gateway/src/journeys.js`): the one link if there is exactly one, an
  explicit refusal naming every candidate if there is more than one, the
  same "enumerate rather than guess" idiom `kelabo_join`'s own omitted
  `kelaboId` already uses. An explicit `journeyId` is trusted only if it
  is actually one of the kelabo's links — never as a bare lookup key, or
  an attached agent could read or write any journey in the deployment by
  guessing an id.
- **`_report_submit` and `_post` are request/response, not fire-and-
  forget.** `kelabo_post`'s own wire shape (`contribution`, no
  `requestId`) was the nearer analogy on paper, but neither of these two
  can succeed silently the way a board post can: a bad `journeyId` or an
  `aiCanPost` refusal is a real outcome the calling model needs back, the
  same reasoning `history`'s `enabled:false` already established for
  "off is an answer, not an error." Both frame pairs carry a `resolved`
  field for exactly this — `ok`, `no_journey`, `ambiguous`,
  `journey_not_found`, plus `ai_posting_disabled` /
  `message_not_found` / `already_archived` on `journey_posted` alone. The
  agent can create or edit a message through this tool; it can never
  archive or unarchive one — that stays a human action via the SPA/REST
  (§7), so there is no `kelabo_journey_archive` tool and none planned.

(The original plan's `report_submit` also carried `suggestedHealth`/
`suggestedProgress` — dropped from the row here too, matching §5/§6: that
whole apply-status flow is not built.)

Tested at three layers: `contracts/test/frames.mjs` (schema round-trips
for all ten new frame types, plus the completeness test's allowlists —
15-wide when this shipped, widened again by §12.3),
`gateway/test/journeys.mjs` (the new `journeys.js` exports,
direct calls, offline) and `gateway/test/smoke.mjs` (the real WS dispatch
in `tunnel.js`, including the `aiCanPost` gate and the ambiguous-journey
path), and `connector/test/smoke.mjs` (the five MCP tools' rendered
prose, against a fake Gateway).

### 12.3 Direct journey attachment + deep context pulls — **built**

Added 2026-08-26, closing the gap between what the in-ECS agent is
*pushed* (§12.1) and what a developer's own agent could *pull* (§12.2):
until this pass a dev agent could read a journey's info, timeline and
board, but not the three things that actually carry context between
kelabos — the other linked kelabos' minutes, document text, and past
reports — and it could not touch a journey at all without a live or
scheduled kelabo to attach to. Both halves are fixed together because
they are one workflow: attach to the journey between meetings, read its
accumulated context, do the work in the developer's own session, post
the outcome to the journey board (`kelabo_journey_post`, §12.2), which
the next kelabo's agent — server- or dev-mode — then sees.

**Six new tools** alongside §12.2's five, same KAP request/response
shape, same `resolved` vocabulary:

| Tool | Purpose |
|---|---|
| `kelabo_journey_join({journeyId?})` | Attach this session to a journey directly — no kelabo, no transcript. No argument lists joinable journeys (`GET /agent/journeys`). Returns the journey briefing. |
| `kelabo_journey_leave({journeyId?})` | Detach from one or every directly-joined journey |
| `kelabo_journey_context({journeyId?})` | The one-call bundle — §12.1's push digest served on demand: description (4,000), pinned board (10 @500), document excerpts (5 @800), linked kelabos as minutes, recent reports (3) |
| `kelabo_journey_kelabos({journeyId?})` | Every linked kelabo reduced to its stored minutes — the same minutes-not-transcripts reduction `kelabo_history` applies, granted by journey membership the way §12.1 already grants it to the in-ECS agent. Never a transcript, never another kelabo's board. |
| `kelabo_journey_documents({journeyId?, docId?})` | List (no content), or one document's full text by `docId` — pull-on-demand where the push clips to an excerpt |
| `kelabo_journey_reports({journeyId?, reportId?})` | List of ready reports (questions only), or one full Q&A by `reportId` |

**Direct attachment** (`journey_attach`/`journey_briefing`/
`journey_detach` frames): requestId-correlated rather than answered with
`rejected`, because a connection may hold several journey attachments and
a bare `rejected` cannot say which request it refuses. Authorization
re-derives rest-api's `resolveAccess` (§3.2) — owner, or same-tenant on a
public journey, or on a private journey's `ACCESSOR#` roster
(`getJourneyAccessor`, the Gateway-side twin of rest-api's
`getAccessor`). Being host or invitee of a *linked kelabo* is
deliberately not enough: that grant is kelabo-scoped and already served
by attaching to the kelabo. A journey in another tenant answers
`journey_not_found`, not `not_journey_member`, so an id cannot be probed
for existence. The attachment lives on the connection
(`conn.journeys`, journeyId → title) and nowhere global — nothing routes
*to* a journey attachment the way transcript routes to `tunnelByKelabo`,
so a closed socket cleans itself up, and the bridge replays its journey
attachments after a reconnect exactly as it replays the kelabo one.
Discovery is `GET /agent/journeys` (rest-api `agent.joinableJourneys`,
same bearer contract and same discovery/authorize split as
`/agent/kelabos`): owned + accessor + public-at-tenant, **active only** —
a completed journey is frozen and the list exists to choose somewhere to
work.

**One resolution for both modes** (`resolveJourneyRequest` in
`gateway/src/tunnel.js`): every `journey_*` request's `kelaboId` became
optional. Present, it means the §12.2 path — attached-or-preparing check,
then the kelabo's own links, with two narrow fallbacks to the direct
attachments (an explicit `journeyId` that is a direct attachment rather
than a link; a kelabo with no links on a connection that also holds
direct attachments). Absent, the direct path: the one attachment if there
is exactly one, `ambiguous` naming the candidates if more, `no_journey`
if none. Response frames' `kelaboId` correspondingly defaults `""`.

**Discovery rides the kelabo briefing too**: `briefing.journeys`
(journeyId + title, from the same §4.3 mirror §12.1 reads) tells an agent
attached to a kelabo that journey context exists and is worth pulling —
before this, nothing did, and the tools sat unused unless the agent
probed speculatively. The bridge renders it as a "Part of journey: …"
line with the tool names; the persona's new JOURNEYS section carries the
same instruction plus the offline-mode brief.

Tested at the same three layers as §12.2: `contracts/test/frames.mjs`
(the new frame pairs, optional `kelaboId`, briefing `journeys`, the
list-vs-full-read split on documents/reports),
`gateway/test/smoke.mjs` (attach authz including the private-off-roster
and unknown-id refusals, direct-mode resolution, detach, self-exclusion
in `journey_context` via the kelabo path), `rest-api/test/smoke.mjs`
(`GET /agent/journeys` buckets and exclusions), and
`connector/test/smoke.mjs` (the six tools' rendered prose, the
kelaboId-less wire shape, reconnect replay of journey attachments).

### 12.4 Deliberately not built here

A tool that asks the *server* to generate a report (rather than
submitting the agent's own answer) remains unbuilt, for the same reason
as before: it would need a new Gateway→rest-api call direction that
exists nowhere else in this system, for a capability an attached agent
can already satisfy itself via `kelabo_journey_report_submit`, which now
exists.

## 13. SPA / UI

**Display-vocabulary note, read once, applies throughout this section:**
three purely cosmetic SPA renames sit on top of an unchanged mechanism.
**Reports are displayed as "Questions" (2026-08-26).** The stored word is
unchanged everywhere it is an identifier: the `REPORT#` item, `reportId`,
`reportCount`, `reportRequestCount`, `/journeys/:id/reports`, the
timeline `type: "report"`, and §12's `kelabo_journey_reports` /
`kelabo_journey_report_submit` tool names — the last of those especially,
since the MCP surface is a published contract (docs 16 §2.B) and renaming
a tool breaks every installed bridge. Only what a person reads changes:
the tab, the empty state, the toasts, the counts on Overview and the
journey list, the contributor line ("N questions asked"), and the delete
confirmation. As with health below, this needed one non-SPA fix — the
timeline sentences, written server-side and read in the SPA, now say
"Question asked" (`rest-api/src/journeys.js`) and "Question answered by
the assistant" (`gateway/src/journeys.js`) instead of "Report requested"/
"Report submitted", for exactly the reason `writeStatusVersion` did.
Agent-facing prose keeps saying *report*, matching the tool names the
model actually calls.
`ownerIdentity`/`isOwner`/`requireOwner`/`myRole:"owner"`/
`not_journey_owner` (§3, §4.1, §11) are unchanged everywhere they are an
identifier rather than a word a person reads — the SPA alone displays the
role as **"Lead"** (`JourneyDetail.jsx`'s People-list and header "Lead: "
labels — the People list originally also read "Lead · creator"; the
second word was dropped as redundant with the field's own label).
Likewise `health`'s stored values stay `"green"|"yellow"|"red"`
(§5's own contract, unchanged) — only the chip/option labels read
**"Full Steam"** / **"Shoal Waters"** / **"Anchored"**
(`Journeys.jsx`'s `HEALTH_LABEL`, `JourneyDetail.jsx`'s `HEALTH_OPTIONS`).
The one place this needed a non-SPA fix rather than just a label swap:
`writeStatusVersion`'s own Timeline sentence (`rest-api/src/journeys.js`)
used to interpolate the raw stored word directly ("Status updated
(health: yellow)"), which would have read as a bug sitting next to a chip
that now says "Shoal Waters" — it renders through the same three words
now, kept local to that one function rather than shared with the SPA's
own label map (this codebase already carries two independent copies of
the bare `green|yellow|red` enum, in `contracts/src/schemas.js` and
`contracts/src/frames.js`; a third, human-prose copy is no worse). Journey
context fed to an LLM or a `kelabo_journey_info` MCP reply (§6.2, §12.1,
§12.2) is deliberately untouched — the raw enum word is arguably *better*
there than a metaphor the model would have to already know to parse.

- **Nav:** new `Journeys` entry in `AppShell.jsx`'s sidebar, beside
  Kelabos. **New journey** is a sidebar action beside New kelabo/
  Schedule/Join, not a button on `/journeys` itself — a `<button>`
  (there's no route to navigate to; creation is a modal) styled
  identically to its `Link`-based siblings via one small reset
  (`button.sidebar-item`, `kelabo.css`), opening the same
  `NewJourneyModal` (now `spa/src/components/NewJourneyModal.jsx`, shared
  rather than owned by the list page) from wherever the user already is.
- **`/journeys`:** list, `{mine, accessible, public}` sections, reusing
  `Records.jsx`'s bucketed-sections-plus-search pattern. Each row: avatar,
  title, status chip, health dot, progress badge, kelabo count, last
  activity. No create action on this page (see Nav, above).
- **`/journeys/:id`:** header (avatar + re-roll if lead, title, status
  chip, health/progress, lead + accessor-count), `Tabs`: **Overview**
  (description, contributor table, status update, action buttons) ·
  **Timeline** (§9.3; a `kelabo_linked`/`kelabo_unlinked` entry links
  straight to that kelabo, routed by its `statusSnapshot` — `kelaboHref()`
  in `JourneyDetail.jsx`, shared with the Kelabos tab below — since
  `/kelabos/:id` only ever resolves once archived: `active` goes to
  `/join/:id`, `ended` to `/kelabos/:id`, anything else (including a stale
  snapshot) to `/scheduled/:id`, which does its own live fetch and
  self-corrects to whatever the kelabo's status actually is now; a
  `document` entry switches to the Documents tab and opens that document
  inline there instead, since a document has no page of its own)
  · **Kelabos** (linked list, add/remove, plus **New kelabo**/**Schedule
  kelabo** shortcuts — `?journeyId=` to `/new`/`/schedule`, pre-filling
  this journey in the picker below, removable before submitting; hidden
  on a completed journey, same guard as "Add a kelabo") · **Questions**
  (§6's reports under their display name — see the note above:
  list + "Ask a question" modal, which carries the §6.4 "Only me" switch;
  a private report shows an "Only me" chip on its row and is simply absent
  for everyone else — no suggested-status apply button; that whole flow is
  out of scope, §5/§17, not merely unbuilt UI) · **Board**
  (§7, per-message history, a "Show archived (N)" reveal toggle,
  Unarchive) · **Documents** (§8, a "Show removed (N)" reveal toggle
  mirroring Board's, content rendered through the same `Markdown`
  component descriptions and reports already use, with `hardBreaks`:
  pasted text is not LLM-authored prose, so a single newline is kept as a
  visible line break instead of Markdown's normal soft-wrap-to-space) ·
  **Helm** (lead-only — see below).
- **Helm — the lead's controls, one place (added 2026-08-26):** rename and
  the avatar re-roll used to sit in the title row, complete/reopen and
  delete in a floating action row under it, `aiCanPost` in Overview, and
  the accessor roster in a tab that appeared only for private journeys —
  five surfaces for one idea. They are now four sections of a single
  owner-only tab, appended last so a member's tab strip is unchanged:
  *Journey* (name, avatar), *Who can see it* (visibility switch + the
  accessor roster, which folds the old conditional tab in), *Assistant*
  (`aiCanPost`), *Lifecycle* (mark complete / reopen, delete). Every
  control is disabled rather than hidden on a completed journey, since
  completion is a freeze the lead can undo from the same tab. Named for
  the vocabulary the journey already speaks (Full Steam / Shoal Waters /
  Anchored; the **Lead** is the one at the helm) rather than a generic
  "Settings"/"Manage". **Overview keeps a read-only On/Off chip for
  `aiCanPost`**: the control is lead-only, but the *state* must stay
  visible to every member — the same disclosure rule §12.1 records for
  `historyEnabled`, and the reason a lead-only tab could not simply
  absorb it.
- **Breadcrumb on existing pages:** `Kelabo.jsx`, `RecordDetail.jsx`,
  `ScheduledKelabo.jsx` show "Part of: `<journey chips>`" when linked.
- **Creation-time linking — built:** `NewKelabo.jsx` / `Schedule.jsx` gain
  `JourneyPicker` (`spa/src/components/JourneyPicker.jsx`), a chip-list +
  modal picker over `api.listJourneys()` (which cannot return a completed
  journey — §11), capped at 10 (`journeyIds`, `contracts/src/schemas.js`).
  `historyEnabled` hides and resets to `false` the moment one is picked
  (§12.1's supersession rule) rather than staying offered pointlessly.
- **Global search:** `SearchDialog.jsx` has a third tab, through the seam
  already built for two — one entry in `TABS`, a third `Promise.allSettled`
  arm, `api.searchJourneys(q)`. The per-tab placeholder moved onto the `TABS`
  entries on the way: a two-way ternary at the input becomes a chain nobody
  updates when a fourth tab arrives. Rows are keyed by `journeyId` and drawn
  with the same identicon the journey list uses, so a journey is recognised
  the same way everywhere.
- **Avatar:** the existing generated-identicon component, seeded by
  `journeyId` (`spa/src/components/ui/Avatar.jsx`), re-rolled the same way
  `Settings.jsx`'s `rollAvatar`/`resetAvatar` already do for a personal
  avatar — no upload, no new subsystem.
- No new CSS system: `.page` / `.row` / `.chip` / `.section-title` /
  `Tabs` / `SkeletonRows` / `.empty`, the existing
  `--success`/`--warn`/`--danger` tokens for health (§5).

## 14. Deletion and retention

### 14.1 Delete journey (owner)

`Query PK=JOURNEY#<id>` → `BatchWriteItem` delete in 25-item chunks with
retry on `UnprocessedItems`, dry-run supported — the same shape as
`deleteKelaboPartition` (`rest-api/src/db.js:589-621`) and
`/records/purge` (`rest-api/src/records.js:183-223`). For each
`LINK#<kelaboId>` found, also delete that kelabo's `JOURNEY#<id>` mirror
row — a kelabo's own META/UTT#/CONTRIB#/MINUTES are never touched by this
operation. `META` is deleted **last**, the same "pointer row dies last so
a crash is resumable" rule `/records/purge` already follows
(`records.js:183-190`).

### 14.2 Unlink one kelabo

Delete both sides of the mirror, decrement `kelaboCount`, write a
`kelabo_unlinked` timeline row. Contributor rollups are untouched (§10).

### 14.3 Purge guard

`DELETE /records/:archiveId`'s host-purge outcome refuses with 409 while
any `JOURNEY#` mirror row exists on that kelabo (checked with the same
query §4.3 describes) — a host must unlink from every journey first. This
is a direct reading of "when a kelabo is part of a journey, it's not
allowed to be removed": the removal being blocked is the kelabo *record*,
not its journey membership, which stays freely removable per §3.3.

### 14.4 No TTL anywhere in this table

Every removal described above is an explicit write. This sidesteps the
one documented trap on the `kelabos` table itself — TTL expiring `META`
while `UTT#`/`CONTRIB#`/etc. are silently orphaned with no sweep — by
never giving this table a TTL attribute to begin with.

## 15. Invariants

The checkable list.

1. A journey's `kelaboCount`, `documentCount`, `reportCount`,
   `boardMessageCount`, `accessorCount` on META always equal the live
   count of their respective item type in the partition.
2. A public journey never has a stored `ACCESSOR#` row that changes what
   anyone may do — visibility alone decides access for public journeys.
3. A private journey with an empty accessor roster is visible/writable to
   its owner only.
4. `completed` blocks every write listed in §3.3's left column, with no
   exception, until `reopen`.
5. A kelabo with at least one `JOURNEY#` mirror row can never be
   host-purged (§14.3) until every mirror row is gone.
6. Deleting a journey never deletes, ends, or otherwise mutates any
   kelabo it was linked to.
7. A removed document or an archived board message is never returned by
   the context assembly in §6.2/§12.1. A removed document is never
   editable again (§8.2); an archived board message is not editable
   *while* archived, but unarchiving restores it exactly (§7) — the one
   deliberate difference between the two soft-delete flows in this
   document.
8. `kelaboJoinCount`/`reportRequestCount` never decrease.
9. Every `TL#` row's `refSk` resolves to an item that either still exists
   or is a recorded soft-delete — the timeline never references something
   that vanished without a trace.
10. A report's `answer` is never mutated after `status` becomes `ready`;
    correcting one means asking a new question, not editing an old
    answer.

## 16. Failure modes, deliberately chosen

- **The LLM call in `POST /journeys/:id/reports` fails or times out.** The
  `REPORT#` row is written `pending` before the call starts and updated to
  `failed` with an `error` field on failure — never left `pending`
  forever, and never silently dropped. The requester's
  `reportRequestCount` is already incremented (§10) — the count is about
  the act of asking, not the outcome.
- **A link/unlink races a journey being marked complete.** The
  `TransactWriteItems` in §4.3 conditions on `status !== "completed"`; the
  loser of the race gets a clean 409, not a partially-mirrored link.
- **A kelabo is deleted (host-purged) while somehow still mirrored.**
  Should not be reachable given §14.3's guard, but if it is (a bug, a
  manual operation), the journey's `LINK#` row becomes a dangling
  reference — read paths must treat a missing kelabo as "no longer
  available," not as an error, the same tolerance §9's timeline already
  needs for a removed document.

## 17. Out of scope here

Everything in this document ships with **no quota, plan, or entitlement
check anywhere** — per doc 19 §4, this is mechanism; policy is designed
separately, additively, on the `saas` branch (private repo) in
`docs/saas/design-journey-quotas.md`, once this document has been merged
there. A self-hosted deployment gets the entire feature with no tuning,
exactly as doc 19 promises for every capability in this system.

Also explicitly not built, and not superseded by anything shipped since
this section was first written:

- Real file upload (§8) — documents remain pasted/typed text only.
- An agent-triggered server-side report (§12.4) — deliberate, permanent:
  the pull tools built for §12.2/§12.3 already give an attached agent
  everything `kelabo_journey_report_submit` needs to satisfy this itself.
- Any journey-level wallet/billing scope.
- A report proposing `suggestedHealth`/`suggestedProgress` and the
  `apply-status` endpoint a member would use to accept one (§5, §6).

Everything else that was tracked here — `kelaboJoinCount` settling on a
live-linked kelabo ending, the "Part of: …" breadcrumb, and the dev-mode
MCP tool surface — is now built; see §10, §12.1's own note, and §12.2.

## 18. Delivery phases — status

1. ✅ **Core** — table, GSIs, CRUD, link/unlink, visibility + accessor
   roster, permission matrix, purge guard (§3, §4, §11 core rows, §14).
2. ✅ **History & timeline** — description versioning, health/progress (§5),
   `TL#` projection, timeline endpoint + UI, avatar.
3. ✅ **Reports** — §6, contributor rollups (§10, both settling paths now
   built) — reports and their SPA tab are built; the AI-suggested-status
   half of §5 is not (see above).
4. ✅ **Board & documents** — §7, §8, `aiCanPost` (enforced — see §12.2).
5. ✅ **Agent integration** — §12. Push (§12.1) is built, verified against
   the full existing agent test suite plus the end-to-end pipeline
   harness. Pull (§12.2) is built: five new KAP frame pairs, five new MCP
   tools, and the "Part of: …" breadcrumb closing the disclosure gap
   §12.1 itself flagged. Direct journey attachment + deep context pulls
   (§12.3) are built: `journey_attach` and four read pairs, six more MCP
   tools, `GET /agent/journeys`, and journey membership on the kelabo
   briefing. §12.4 remains deliberately unbuilt.
6. **SaaS quotas** — entirely additive, no master changes required; see
   the companion document.
7. ✅ **Threads** — §19. `THREAD#`/`MSG#`/`READ#` rows, thread CRUD, the
   Gateway's HTTP surface, the shared `src/chat/` components and the Threads
   tab (§19.2–§19.6); pin-to-board (§19.7); `@person` mentions with their own
   counter (§19.8); realtime fan-out over the presence stream, with the named
   keepalive and client watchdog it required (§19.9); the `@kelabo` assistant
   and its three MCP tools (§19.10); unread badges at every level from the
   rail down to the thread; and `GET /journeys/search` with its tab in the
   search dialog (§11). What remains is in §19.11.

---

## 19. Threads — persistent conversation on a journey

> **"Thread" here means a named top-level conversation**, the way "channel"
> does elsewhere — not a reply-chain hanging off one message. `msgId` remains
> the only grouping key *inside* a thread, and nothing re-derives structure
> from adjacency, author or time.

### 19.1 What it is, and why it is here rather than on a kelabo

A kelabo is a meeting: it starts, it ends, it becomes a record. That is the
right shape for people talking at the same time, and the wrong shape for
people talking *across* days — where nobody expects an immediate answer and
the context has to still be there tomorrow.

The obvious move is a long-lived kelabo. It is the wrong one, for reasons
that are structural rather than aesthetic:

- The agent's trigger gate sends the **entire transcript** to the LLM on
  every caption (`gateway/src/agent/gate.js`). Cost per message grows with
  the age of the room; total cost is quadratic.
- The worker keeps the full transcript in memory and never trims it
  (`gateway/src/agent/worker.js`), alongside a second unbounded
  `MainAgent.thread`. Both are freed only by `endKelabo`.
- `ttl` is written **exclusively** by `endKelabo`
  (`gateway/src/archive.js`). A kelabo that never ends never gets one.

A journey already is the durable container, and it already has the two
things a channel needs and a kelabo does not: a membership model that is not
tied to one meeting (§3.2), and `status: active | completed` — which is
exactly "not ended", with `reopen` as its inverse. So the channel writes to
the journey, and none of the above applies: nothing is retained in Gateway
memory between messages, and the journeys table deliberately has no TTL
(§14).

**A thread is not the board.** §7's board is a small, curated set of pinned
messages, read in full, mutable, versioned. A thread is the opposite shape —
many messages, paged, read from the end, never read in full. They are
different objects that happen to both contain text, and merging them would
make the board unusable at conversation volume. In thread vocabulary the board
is "pinned messages", and §19.7 promotes one into the other.

**It is not the kelabo transcript either.** A kelabo's `source: "typed"`
message is speech somebody typed during a meeting; it belongs to that
meeting's record. This belongs to the journey and has no meeting.

### 19.2 Items

Both live in the journey's own partition, so `deleteJourneyChildren` (§14)
reclaims them with everything else.

| SK | Fields |
|---|---|
| `MSG#<msgId>` | `msgId, at, author, text, kind, editedAt?, deletedAt?, deletedBy?` |
| `READ#<identity>` | `lastReadAt, lastReadMsgId, messageCountAtRead, updatedAt` |

META gains `messageCount` and `lastMessageAt`. It deliberately does **not**
bump `updatedAt`: that is the journey list's sort key, and letting chat drive
it would reorder everybody's journey list every time anyone typed.

**`msgId` is the sort suffix itself** — `<pad(at,13)>-<rand6>`. One value is
the identity, the ordering key and the paging cursor, and `SK = MSG#<msgId>`
makes edit and delete a point read rather than a scan for a uuid. The
separator is a hyphen, not the `#` every other sort key here uses, because
this id travels in a URL path where `#` starts a fragment.

`at` comes from a **monotonic clock**, not `Date.now()`
(`monotonicNow` in `gateway/src/journeys.js`). Two messages sent in the same
millisecond would otherwise share a timestamp and fall back to the random
suffix for their order — so pasting two lines could store them, and page them
back, swapped. Everywhere else that suffix breaks ties between events with no
inherent order; one person's own consecutive messages very much have one.

There is no `authorName`. The Gateway has no access to the users table and
never learns display names — the same constraint documented on the presence
stream (docs 18 §5.4), resolved the same way: the SPA maps identities to
names itself. A name stored on the row would be a snapshot nobody updates.

### 19.3 Unread

`unread = thread.messageCount − cursor.messageCountAtRead`, per thread. O(1),
no scan, which is the whole reason for the two counters.

**A journey-level counter cannot be stored instead of the sum.** Reading one
thread would advance it to the journey's total and hide every other thread's
unread — the badge would clear itself by looking at the wrong conversation.
So the journey list sums per-thread cursors, which is two small Queries per
journey (`THREAD#` rows and `READ#<identity>#` rows), in parallel and capped at
`UNREAD_SCAN_CAP`. Past the cap journeys still render, without a badge — never
with a wrong one. The arithmetic itself is `contracts/src/journeyUnread.js`,
shared so the Gateway's per-thread answer and rest-api's rollup cannot
disagree.

It only works because **`messageCount` never goes down**: an edit does not
touch it, and a delete is soft (§19.5). A counter that can decrease cannot be
differenced against a cursor written before the decrease.

The cursor is monotonic server-side (`attribute_not_exists(SK) OR lastReadAt
< :at`). Two tabs racing, or a client replaying an older position after
scrolling up, must never push somebody's unread count back up. A message
landing in the same instant as a mark-read is counted as read; that window is
milliseconds, it self-heals on the next message, and every chat product
behaves this way.

The "New" line in the UI is frozen at first load rather than recomputed as
the cursor advances — a boundary that creeps down the screen while you read
past it is worse than none.

### 19.4 Where it is served, and by what credential

Writes and reads of *messages* are on the **Gateway**; everything else about
a journey stays in rest-api. This is the same split the kelabo already makes
— captions POST to the Gateway, kelabos are created over REST — and the
reason is the same: this is the per-message hot path and the control plane is
a Lambda. The journey **list**, with its unread arithmetic, stays in rest-api
because that is where the three-bucket discovery query and its two GSIs
already are.

| Method | Path (Gateway) |
|---|---|
| GET | `/journeys/:id/threads` — with each reader's own unread; creates the default thread if there is none |
| POST | `/journeys/:id/threads` |
| PATCH | `/journeys/:id/threads/:tid` |
| GET | `/journeys/:id/threads/:tid/messages?before=\|since=&limit=` |
| POST | `/journeys/:id/threads/:tid/messages` |
| PATCH | `/journeys/:id/threads/:tid/messages/:msgId` |
| DELETE | `/journeys/:id/threads/:tid/messages/:msgId` |
| POST | `/journeys/:id/threads/:tid/messages/:msgId/pin` |
| POST | `/journeys/:id/threads/:tid/read` |

Authenticated by the browser **SESSION cookie**, like `/presence/stream` and
unlike everything kelabo-scoped. A journey has no participant cookie, no join
link and no guests (§3.2) — membership is a property of the identity.

Access is `resolveJourneyAccess` in `gateway/src/journeys.js`, which is now
the single Gateway-side implementation of journey membership:
`tunnel.js`'s `mayAttachJourney` is a boolean wrapper over it. An agent over
`/rig` and a member over HTTP are the same question asked by two credentials,
and this used to be the only copy of the answer.

**A journey you may not read answers 404, never 403** — `journey_not_found`
and "not yours" are the same answer, so an id cannot be probed for existence
by watching which error comes back. Same rule `onJourneyAttach` applies.

**A completed journey is read-only, and its badge can still be cleared.**
Posting to one is `409 journey_completed`; reading and advancing the read
cursor both still work. Refusing the cursor would leave a badge nobody could
ever clear.

**A message range must end at `MSG#<threadId>$`**, one byte above `#`. Threads
made this sharper than it was: `MSG#general2#…` sorts above `MSG#general#…`, so
a looser upper bound swallows a sibling thread's entire conversation into this
one — not just the neighbouring-prefix rows the timeline's own cursor once
walked into.

### 19.5 Edit and soft delete

Editing is **author-only** (`not_message_author`) — narrower than the board's
author-or-lead archive rule, deliberately: a lead may remove somebody's
message but must never be able to put words in their mouth. Deleting is
author-or-lead, reusing `not_message_author_or_lead`.

There is **no `#V#` version chain**, unlike the board. A pinned board message
is a decision of record and its history is part of the journey's audit trail;
a chat message is not, and a chain here would double the write volume on the
hottest path in the system to preserve typo fixes. For the same reason no
`TL#` row is written per message — the timeline stays a record of structural
change.

Delete is soft: the row stays, `text` is REMOVEd and `deletedAt` stamped, so
the tombstone renders in place. Two reasons, and the first is the load-bearing
one: `messageCount` must not decrease (§19.3), and a message that vanishes
from the middle of a conversation takes its replies' context with it.

### 19.6 One wire shape, one merge path

Create, edit and delete all return and fan out **the same message object**,
and the client upserts by `msgId`. Three events for one row is how a client
ends up with two copies of a message it already had.

The reducer is `spa/src/chat/messageStore.js` — pure, node-tested
(`spa/test/journeyChat.mjs`), for the same reason the transcript modules are.
It sorts by `msgId` rather than `at` (a total order versus a partial one) and
refuses a delivery staler than the copy it holds, so a page fetched before an
edit and arriving after it cannot silently revert the message.

`src/chat/` also holds `MessageList`, `useFollowingScroll` and `Composer`,
lifted out of `room/SidePanel.jsx` when the channel became the second message
list. The room and the channel are the same list; the only difference is what
goes inside a bubble (the room has a live unconfirmed tail), which is the
`renderBody` prop and the only seam between them.

### 19.7 Pinning to the board

The board (§7) is the journey's curated, always-visible surface; the channel is
its conversation. Pinning is the one bridge, and it runs in **that direction
only** — a board message is never demoted into chat.

`POST /journeys/:id/messages/:msgId/pin` produces an ordinary board message by
an ordinary member: head, `#V#000001` version row, `boardMessageCount`,
timeline row, exactly as `addBoardMessage` does. It carries `pinnedFrom` and
`pinnedAt`; the channel row is stamped `pinnedAs`.

**Two ids, deliberately not one.** Board message ids are uuids and channel ids
are `<pad(at,13)>-<rand6>`; reusing one as the other would put a channel id
into a namespace that assumes uuids.

**Idempotent** — a second pin returns the board message that already exists,
with `200` rather than a second `201`, so a double click puts one card up.
A deleted message cannot be pinned: its text is gone and the tombstone would
be an empty card.

`aiCanPost` does **not** apply. That flag gates the assistant editing a curated
surface unsupervised; this is a person promoting something they can already
read. Anyone who may write to the channel may pin — the board is shared, and
the message is already visible to everyone there. Editing and deleting stay
with the author (§19.5).

### 19.8 Mentioning a person

`@bob` or `@bob@example.com`, resolved **server-side** against the journey's
own people and stored on the row as `mentions: [identity]`. Never taken from
the client: the list is what raises somebody else's badge, so a client that
supplied it could notify anyone it liked.

The grammar is in `contracts/src/mention.js`, beside the assistant matcher and
deliberately not the same function as it. Addressing the assistant is a
decision that skips the trigger gate; mentioning a colleague raises a badge. A
false positive costs a needless LLM call in one case and a needless
notification in the other, and those are not the same price.

The left-hand lookbehind is the load-bearing part: without it an ordinary email
address in prose — "write to bob@example.com" — reads as a mention of
`@example.com`, and everyone whose local part is "example" gets a badge.

**Who a handle can resolve to** is owner + the `ACCESSOR#` roster + anyone who
has spoken in the last 200 messages — which is what `@` means in a
conversation, the people in it. An **ambiguous** local part (two identities
differing only by domain) resolves to *nobody*: notifying both tells the wrong
person they were named, and picking one does it silently.

A **public** journey has no roster at all — membership is a `tenantId` match
computed at read time (§3.2) and the Gateway cannot enumerate a tenant. So on
one, a bare `@bob` resolves only if Bob is the lead or has already spoken here;
anyone else must be named by full address, which is accepted on the tenant test
alone. That asymmetry is a consequence of visibility being derived rather than
stored, and it fails in the safe direction: an unresolved handle raises no badge
and tells nobody.

**The counter lives on the `READ#` row**, as `mentionCount`, differenced
against `mentionCountAtRead` — the same O(1) arithmetic as §19.3 and, again,
never decremented. It is on that row rather than one of its own because the row
already exists per identity per journey and already holds the cursor, so the
badge is one point read instead of two.

> ⚠️ That has a consequence worth stating, because it was a live bug: **being
> mentioned creates the `READ#` row before its owner has ever opened the
> channel**, so the row exists while `lastReadAt` does not. DynamoDB evaluates
> `lastReadAt < :at` against a missing attribute as **false**, not as "unset,
> so anything is newer" — so the cursor guard must be
> `attribute_not_exists(SK) OR attribute_not_exists(lastReadAt) OR lastReadAt <
> :at`. Without the middle clause the cursor can never advance, and the badge
> sticks at unread permanently, for exactly the people who were mentioned.

The SPA restates the token grammar in `spa/src/chat/mentions.js` — it has no
dependency on the contracts package, and the exports there are non-global and
non-indexed, so they answer "is this addressed to the assistant?" rather than
"where are the mentions?". The restatement is safe in the only direction it can
fail: that module decides what to **style**, the server decides who was
**mentioned**. A token highlighted with nobody behind it is a word in a
different colour. `mentionsMe` is stamped by the server onto each message for
the same reason — a client re-deriving it would be a second implementation of
the matching rule that could disagree with the badge it sits beside.

### 19.9 Realtime

A thread message is pushed over the **presence stream**, not a stream of its
own. It is already open on every page of a signed-in tab, it is authenticated
by the session cookie — exactly the credential a journey uses — and it already
carries a non-presence payload in the ring. A dedicated journey stream would
be a third `EventSource` against the browser's six-per-origin budget, and it
would still not solve the cross-journey badge: you are by definition not
subscribed to the journey you are not looking at.

**Audience** is owner + `ACCESSOR#` roster for a private journey, and everyone
from the tenant holding a stream for a public one — **never** a public
journey's accessor rows, which a private→public flip leaves behind inert
(§3.2) and which reading here would resurrect as a notification list. An
offline member is simply not pushed to; their badge is correct the moment they
load a page.

**The whole message travels**, not a nudge to go and look, so a client already
reading that thread renders it immediately — the difference between a chat and
a page that refreshes. Everyone else uses the event only as a signal to
refresh, and the counts stay server-computed: the event is never the source of
a badge number, only of the decision to go and ask for one. Refreshes are
debounced so a burst of messages costs one round trip.

**The author is included** rather than skipped. Their other tabs need it, and
the tab that posted merges it by `msgId` into the copy it already applied.

**Every surface still polls, slowly, as a backstop** (45–60s: the thread's own
messages, the journey's thread list, and the rail's journey list). This stream has
no replay by design (docs 18 §5.4), so an event missed across a reconnect
would otherwise be a badge that never appears. Push is what makes it fast;
polling is what makes it eventually right.

> The keepalive had to change for this. It was an SSE **comment**, which keeps
> a proxy from idling the connection but is invisible to `EventSource` — so a
> client could not tell a quiet stream from a half-open socket, and no
> staleness watchdog was possible. It is a named `ping` event now, the same
> lesson `sseHub` records for the caption stream, and `usePresence` carries the
> watchdog that depends on it. It did not matter while this stream carried only
> presence and rings, both of which self-correct; it matters when a dead socket
> means somebody silently stops being told anything.

### 19.10 The assistant, on `@kelabo` only

Typing `@kelabo …` in a thread gets an answer, posted into that same thread as
a message of `kind: "assistant"`.

**No trigger gate.** `addressesAssistant` is already the strict, typed-only
matcher — the person saw what they wrote — and running a classifier over a
conversation would reintroduce exactly the per-message cost §19.1 exists to
avoid. Being addressed is the whole decision.

**Stateless per request.** Context is built from rows in DynamoDB, one call
answers, the answer is written as an ordinary message. Nothing is retained
between mentions, so none of the memory or quadratic-token problems that make
a long-lived kelabo expensive apply.

What the model is given: the journey (`buildContext` — description, pinned
board, documents, linked kelabo minutes, prior **public** reports), **every
thread's name and size**, and **the current thread's recent messages**. Names
only for the other threads: reading them all on every mention would put the
journey's entire conversation into every prompt, which is the cost model this
design rejects. The private-report rule is inherited from `buildContext` and
matters more here than for a report — this answer is posted where everyone
reads it, so folding in one member's private question would publish it.

> ⚠️ **The dispatch is guarded on `kind === "message"`, and that guard is
> load-bearing.** The assistant's own reply can contain the string `@kelabo` —
> quoting the question back is the obvious way for it to do so — and
> dispatching on that is an unbounded loop that bills the deployment for every
> turn of it.

Three smaller decisions:

- **Retried** with `withLlmRetry`, which `generateJourneyReport` deliberately
  does not use. A failed report leaves a visible `failed` row somebody can
  retry; an answer that never appears is indistinguishable from being ignored,
  which is the failure this feature exists to fix.
- **A failure posts a message saying so**, never silence.
- **Its own metering seam** (`allowJourneyChatAnswer` / `noteJourneyChatAnswer`),
  named apart from the report's: a hosted fork's per-report quota must not
  silently meter chat, which is a different act at a different frequency.

The author on an assistant message is `kelabo`, not an email. It can therefore
never equal a session identity, so `editJourneyMessage` refuses every editor,
and `journeyPeople` never offers it as a mentionable person.

**For a dev agent** there are three MCP tools — `kelabo_journey_threads`,
`kelabo_thread_messages`, `kelabo_thread_post` — all *agent-initiated*.
`thread_post` is **not** gated by `aiCanPost`: that flag guards the board, a
curated surface edited unsupervised, while a thread is the conversation, where
an attached agent is a participant. Thread messages arrive inside a
`<kelabo-thread untrusted="true">` envelope, like every other multi-contributor
surface.

### 19.11 Not built yet

- **Telling an agent it was mentioned.** The three MCP tools are all
  agent-initiated (§19.10). A *push* — "somebody named you in thread X" —
  needs `state.journeyTunnels`, the journey-keyed reverse index whose absence
  `tunnel.js` documents as deliberate, plus a down-frame and an unwind in
  `ws.on("close")`. The server-side path is what makes `@kelabo` answer for
  someone with no agent attached, and it is built.
- **A notification outside the tab.** Unread now reaches the rail, the journey
  row, the tab and the thread (§19.3), but only while the app is open. A
  browser notification for a mention would reuse `notify.js`, which is already
  gated on `document.hidden`.

**Reply-chains** are deliberately absent, and are a different thing from the
named threads this section describes. `msgId` is the only grouping key inside
a thread, and adding a parent would break that invariant for a feature nobody
has asked for.
