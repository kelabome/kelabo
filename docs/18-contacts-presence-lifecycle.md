# 18 — Contacts, Presence & Kelabo Lifecycle

Design for four related capabilities — written when none of them existed; cancel,
reschedule, favourites and presence are since built, with the external-contacts
half gated off by config (see the status line below):

1. **Cancel** a scheduled kelabo.
2. **Reschedule** a scheduled kelabo.
3. **Contacts** — the people you can see and reach: everyone in your own org
   (derived, not stored) plus *external* people you and they have each agreed to.
4. **Presence** — who among those is online right now, and whether they are in a
   kelabo.

A fifth capability, the **huddle/ring** (send a request, they join by accepting,
Slack-huddle style), is designed here at the end and is now **built** (§6) — it
builds directly on presence and adds nothing the first three need.

This doc is the authoritative design and precedes the code. Component docs
(01-spa, 02-rest-api, 03-gateway, 07-cdk-infra, 08-database) describe what was
built; this doc says what to build and why.

Everything here is implemented except **external contacts** (§4.3 `PEER#`),
which are config-gated (§0) and inert in a single-domain deployment.

---

## 0. The one hard constraint: cross-org identity

**External contacts cannot function in self-host mode, by design.**

`config.allowedEmailDomain` is a single string per environment, and both auth
paths reject everything else: OTP (`rest-api/src/otp.js`) returns
`403 domain_not_allowed`, OIDC (`rest-api/src/oidc.js`) the same plus an
`email_verified` check. A person outside the configured domain therefore **cannot
obtain an account**, so they can never *accept* a contact request and can never
carry presence. Guests are not a substitute: `guest:<uuid>` is regenerated on
every join and `g:<uuid>` exists only inside one kelabo's partition — neither is
a stable identity to hang a contact or presence on.

This is a property of **self-host mode and is intended.** The multi-domain /
open-signup deployment model that makes external contacts real is recorded here
and in `ARCHITECTURE.md`, not built now.

Consequence for this design: the external-contact half of the feature is **built
but inert** in self-host mode. A single derived config flag,
`config.contacts.external` (default `false`), gates:

- the "add an external contact" routes (they return `501 external_contacts_unavailable`),
- the external-contact UI (hidden),
- the cross-tenant half of presence fan-out.

The **org half — the directory and same-org presence — works today** and is not
gated. If a deployment enables multi-domain signup, flipping the flag activates
the rest with no schema change.

> Note: a dev environment whose `allowedEmailDomain` is a shared domain (e.g.
> `gmail.com`) makes "same org" mean *every account on that domain*, and the
> "you cannot remove a colleague" rule applies to all of them. This is a
> config artefact, not a bug.

---

## 1. Where this fits the existing grain

Three facts from the current system shape every decision below.

**Presence is already solved once — for conference audio.**
`gateway/src/rtc/room.js` keeps `Map<kelaboId, {peers: Map<identity, Peer>}>`
in process, fans `peer_joined`/`peer_left` over SSE, and learns of a departure
from `res.on("close")` on the participant's event stream
(`gateway/src/sseHub.js`) — reference-counted so an EventSource reconnect never
evicts someone who is still there. `desiredCount: 1` (all three envs) is what
makes in-process presence globally consistent. **Contact presence is the same
mechanism widened from one kelabo to one tenant + accepted peers.**

**But every stream today is kelabo-scoped.** `sseSubscribers` is keyed only by
`kelaboId`; the participant cookie is scoped to one kelabo
(`verifyParticipantCookie`); and the SPA holds *no* connection outside `/m/:id` —
on Home the only network activity is `api.listKelabos()` every 8 s in
`AppShell`. Presence needs the **first browser-facing, non-kelabo-scoped**
Gateway route.

**There is deliberately no org address book.** `dynamodb-stack.js` and
`08-database.md` record the decision: the registered users *are* the list, via
`users.tenant-index`. This design keeps that — colleagues are **derived, never
stored**, which is precisely why "you cannot remove a colleague" is *structural*
(there is no row to delete) rather than a rule enforced somewhere. Only *external*
links are new persisted state.

---

## 2. Cancel a scheduled kelabo

### 2.1 Cancel vs. end — two verbs, kept apart

- **Cancel** applies **only to `scheduled`** kelabos. It disposes of a kelabo
  that never happened. There is no archive, no minutes, no record.
- **End** applies to **`active`** kelabos (it already exists,
  `POST /kelabos/:id/end`). It produces an S3 archive, a history row and
  minutes.

Keeping these distinct is the whole point. Today the only "Cancel" button in the
UI (`spa/src/routes/Lobby.jsx`) actually calls `endKelabo` on a *live* kelabo;
and `endKelabo` rejects anything not `active`, so a scheduled kelabo can never
be disposed of and its META row is **immortal** (no `ttl` is ever set on a
never-started kelabo). Cancel fixes both.

### 2.2 New status `cancelled` — and the status audit

A fourth status value is genuinely dangerous: every existing status check is
`=== "active"` / `=== "scheduled"` / `=== "ended"` with a **permissive else**, so
a new value silently takes a wrong branch. Every site that must change:

| Site | Today | Must become |
|---|---|---|
| `rest-api/src/kelabos.js` `getKelabo` | `!== "active"` ⇒ `410 kelabo_ended` | explicit `409 kelabo_cancelled` |
| `rest-api/src/join.js` | same fall-through | same |
| `rest-api/src/scheduling.js` `rsvp` | guards only `=== "ended"` | **reject `cancelled`** (today an RSVP to a cancelled kelabo would succeed) |
| `rest-api/src/scheduling.js` `getInvitation` | `active`/`ended` only | report `cancelled` |
| `gateway/src/tunnel.js` `onAttach` | `else` ⇒ full transcript-receiving attach | reject `cancelled` |
| `gateway/src/tunnel.js` `sendBriefing` | `scheduled ? "scheduled" : "active"` | never briefs a cancelled kelabo as `"active"` |
| `spa/src/routes/ScheduledKelabo.jsx` | falls through to "scheduled" chip + **Start now** | cancelled state, no Start button |
| `spa/src/routes/Invitation.jsx` | `active`/`ended` only | cancelled state |

### 2.3 Route & write

`POST /kelabos/:id/cancel` — `requireSession`, **host only**, body
`{ reason?: string ≤200 }`.

The DynamoDB write (new `db.cancelScheduledKelabo`) is a **conditional update**
on `KELABO#<id> / META`:

```
SET  #status = :cancelled,
     tenantStatus = :ts,          -- <tenantId>#cancelled  (NOT removed)
     cancelledAt = :now,
     cancelReason = :r,
     ttl = :ttl
ConditionExpression: #status = :scheduled
```

- **`ConditionExpression: #status = :scheduled` is the serialization point**
  against `start-scheduled` (whose own condition is the mirror image). A cancel
  and a "Start now" that race resolve cleanly: one wins, the other gets a
  condition failure surfaced as `409`.
- `tenantStatus = <tenant>#cancelled`, **not removed.** (Note: the *end* path is
  inconsistent here — REST removes `tenantStatus`, the Gateway sets `#ended`. We
  set `#cancelled` and leave the pre-existing `ended` discrepancy alone rather
  than widen the change.)
- `startedAt` stays **`0` (a Number)** — a `null` silently un-indexes the row
  from `status-index`.
- `ttl = now/1000 + retentionDays*86400`. This is the **first** place a
  never-started kelabo is given a `ttl`, so cancelled kelabos self-expire.
- **`HOSTACTIVE` is left untouched** (historical: the guard itself was removed
  2026-07-31 — hosts may now run several live kelabos).

### 2.4 Gateway teardown — a prep-bound agent must be told

An agent may be *preparing* for a scheduled kelabo (`state.prepByKelabo`). It
has to learn the kelabo is gone. This adds the **third** internal Gateway action.

- `gateway/src/server.js` internal allowlist regex: `(end|minutes)` →
  `(end|minutes|cancel)`.
- `rest-api/src/internal.js`: add `cancelKelabo(kelaboId, identity)`.
- `POST /internal/kelabos/:id/cancel` on the Gateway:
  1. send `{ type:"kelabo", event:"cancelled" }` to `state.prepByKelabo.get(id)`
     if present,
  2. drop `prepByKelabo`, `tunnelByKelabo`, `promotedByKelabo`, `lastCaption`
     for the kelabo,
  3. `rtcRoom.closeKelabo(id)`,
  4. `sseHub.ended(id, { reason: "cancelled" })`.

> `endKelabo` never clears `prepByKelabo` today (a pre-existing small leak).
> The cancel path clears it; we do not retrofit the end path in this change.

Ordering mirrors `archive.js`: close the RTC roster and drop `lastCaption`
*before* `sseHub.ended`, because `ended` closes every SSE response and each close
would otherwise fire a per-peer "left" fan-out into a room with no subscribers.

### 2.5 Notifications

- **Email:** new `sendCancellation` on `createSesSender`
  (`rest-api/src/otp.js`), sent to every `INVITE#` row that has an `email`, except
  the host. Per-recipient, non-fatal — same pattern the invite loop already uses.
- **Agent wire:** `frameKelaboSchema.event` gains `"cancelled"`.
- **SSE:** the existing `ended` event carries `{ reason: "cancelled" }`. For a
  scheduled kelabo there are usually no browser subscribers, so email is the real
  channel.

### 2.6 SPA

- `ScheduledKelabo.jsx`: host action row gains **Cancel kelabo**
  (`variant="outline-danger"`, via `useConfirm`). On success, remove it from the
  shell's `scheduled` list optimistically — that list reloads on navigation, not
  on a timer, so without optimistic removal the cancel looks like it did nothing.
- `Invitation.jsx`: render a "This kelabo was cancelled" state.
- `api.js`: `cancelKelabo(id, reason?)`.

### 2.7 Contracts

- `constants.js`: `kelabo_cancelled`, `not_scheduled`, `nothing_to_change`.
- `schemas.js`: `cancelKelaboBodySchema`.
- `frames.js`: `frameKelaboSchema.event` += `"cancelled"`, `"rescheduled"`;
  optional `scheduledAt` field.
- `typedefs.js`: `KelaboCreated.status` is already stale (cannot express
  `scheduled`) — widen to the real union and add `"cancelled"`.

### 2.8 Cross-tenant invitees — the other half of "who can see this"

Every kelabo list in this document — `listScheduled`, `listKelabos`,
`joinableKelabos` (the agent bridge) — was, until now, a query against
`status-index`, keyed on **`tenantStatus`**: `<hostTenant>#<status>`. That
finds everything at the caller's own tenant, which covers the ordinary case
(a host invites a colleague) by construction, and does not mention invitees
at all — colleagues at one tenant are simply, tenant-wide, each other's
audience.

It does not cover the other ordinary case: a host inviting someone at a
*different* domain — a contractor, a partner, a friend on open registration.
That invitee's own tenant is not the host's, so `status-index` cannot reach
the kelabo from their side no matter what they query — the kelabo was never
indexed under their tenant, and no `#<status>` query for their own tenant
will ever be indexed there either. The invitee gets the email, replies, and
the host sees the reply; the invitee's own home page never shows it again.
Reachable only by re-opening the original link, indefinitely — not a race,
not eventual consistency, structurally absent.

**The fix:** a second GSI, `invitee-index`, sparse on `inviteKey` — the same
sparse-index trick `status-index` itself plays on `tenantStatus`, since only
an `INVITE#` item carries either attribute. `db.listKelabosByStatusForIdentity`
composes both: `status-index` for the caller's own tenant, `invitee-index` for
every kelabo hosted anywhere else that has an `INVITE#` row naming the
caller — returned as two separate arrays, not merged, because they carry
different visibility rules. `listScheduled` and `joinableKelabos` already
gate on "host or invited" uniformly, tenant or not, so widening their
candidate set is the whole change. `listKelabos` does not — a non-`unlisted`
kelabo is visible tenant-wide by default — and that default has no cross-
tenant analogue: a kelabo hosted elsewhere is visible only because a specific
`INVITE#` row names the caller, never because it merely isn't `unlisted`.

No backfill: a new GSI is populated from every existing item that already
carries the attribute, automatically, so an invite written before the index
existed is reachable the moment the index finishes building.

---

## 3. Reschedule a scheduled kelabo

### 3.1 Route

`POST /kelabos/:id/reschedule` — host only, kelabo must be `scheduled`.
Body `{ scheduledAt?, durationMinutes?, title?, note? }`, all optional, **at least
one required** (`nothing_to_change` otherwise). New
`rescheduleKelaboBodySchema` in contracts.

Same `ConditionExpression: #status = :scheduled`. Records `rescheduledAt` and
`previousScheduledAt` so the invitation page can say "moved from …".

### 3.2 RSVP handling — reset only when the time changes

Decision: **reset non-host `accepted`/`declined` responses to `pending` only when
`scheduledAt` actually changes.** A title or note edit keeps everyone's RSVP; a
time change invalidates "I can attend", so those go back to pending and a
reschedule email goes out. The host's own auto-RSVP stays `accepted`.

There is no `updateInvite` today (`putInvite` is an unconditional full `Put`), so
this adds `db.resetInviteResponses(kelaboId)` — loop `listInvites`, and for each
non-host row clear `respondedAt` and set `response: "pending"`, preserving
`invitedAt`.

### 3.3 Notifications & Gateway

- **Email:** `sendReschedule` ("was X, now Y"), sent **only if the time moved**.
- **Agent wire:** `{ type:"kelabo", event:"rescheduled", scheduledAt }` to the
  prep binding.

### 3.4 SPA

`ScheduledKelabo.jsx`: a **Reschedule** button next to Cancel, opening a small
inline form that reuses `DateTimePicker.jsx` — the same fields as `Schedule.jsx`
minus invitees. Editing invitees is a separate button and a separate route
(§3.5), not folded into this form: they are different questions with
different blast radius, and a host fixing a title typo should not be shown a
list of people they could accidentally drop.

### 3.5 Add and remove invitees

The route named and deferred above, now built: `POST /kelabos/:id/invitees`,
host-only, scheduled-only — the same guard §2 and §3 use. New
`updateInviteesBodySchema` in contracts.

**Shape: the full desired list, not an add list and a remove list.** The body
is `{ invitees: [...] }`, the same field `scheduleKelaboBodySchema` already
has. `scheduling.js` diffs it against `listInvites`, so the caller — in
practice, `EmailPicker`'s controlled `value`, the same chip input
`Schedule.jsx` already uses — never has to track what changed, only what the
list looks like now. A client-computed diff can also be wrong in a way a
server-computed one cannot (a chip removed and re-added in the same edit, a
race with another open tab); a full-list PUT-shaped body sidesteps that
entirely.

The diff excludes the host's own row and any guest-only RSVP (`inviteKey`
starting `g:`, someone who answered the link directly without an account):
neither was ever something the host typed an address for, so neither is
addable or removable here. Sending the host's own address back in the list is
harmless, not an error — it is simply outside the set this route touches.

**Added** addresses get exactly the create-time `putInvite` + `sendInvite`
(`inviteMessage`) — a new invitee added after the fact is not a different kind
of invitee. **Removed** addresses get `db.removeInvite` (an actual delete, the
first place this partition needs one — `putInvite` had always been an
unconditional full `Put` until now) and a new, deliberately short mail,
`uninviteMessage`/`sendUninvite`: *"`{host}` removed you from `{title}`. It is
still happening, just without you."* Distinct from `cancellationMessage` on
purpose — the kelabo is not going away, only this person's place in it, and a
cancellation-shaped email would say the wrong thing.

An empty diff (the same list handed back) is `nothing_to_change`, same as an
empty reschedule.

---

## 4. Contacts

### 4.1 Three kinds of contact

1. **Colleagues (same org)** are **derived** from `users.tenant-index`, never
   stored as a relationship. Everyone in your domain exists to you; the org
   boundary is the directory. This honours the recorded "no address book"
   decision.
2. **Favourites (same org)** are a **private, one-way, unmirrored** marker on top
   of a colleague. You favourite a colleague to pin them; the org list you *see*
   is your favourites, and the rest are found by **search**. The other person is
   **never told** they were favourited or unfavourited — there is no accept, no
   reciprocity, no notification. Remove anytime. This is the model chosen
   for and is the primary org-contacts experience.
3. **External contacts** are **mirrored pairs** of stored rows, created only by
   mutual agreement, removable by either side (symmetric disconnection), each side
   visible to the other. Inert until `config.contacts.external` is true (§0).

**Favourite (2) and external contact (3) are opposites and must not be
conflated:**

| | Favourite (same org) | External contact |
|---|---|---|
| Direction | one-way, private | two-way, mutual |
| Rows written | **one** (mine only) | **two** (mirrored pair) |
| Other end knows? | **never** | yes, both see the link |
| Consent | none — unilateral | request → accept |
| Remove | unilateral, silent | either side, symmetric |
| Gated by `external` flag? | **no** — works in self-host | yes |

### 4.1a Favourites — behaviour

- The Contacts screen lists **only your favourites** by default. Non-favourited
  colleagues do not appear until you search.
- **Search** (`GET /people/search`, already exists) returns any colleague by
  name/email prefix, and each result carries `favourited: boolean` and presence
  so you can see their state and favourite/unfavourite them **from the result**.
- You can also favourite from the **kelabo room** — a participant who is a
  same-org colleague gets an "add to favourites" affordance on their tile / in the
  participant list.
- Unfavouriting is immediate and silent. Because the marker is one row you own,
  removing it is a single `DeleteItem`; the other person's view is unchanged
  because they never had one.
- Favouriting is only valid for a **same-tenant** identity (a colleague). An
  attempt to favourite an outside address is `409 not_a_colleague` (that is what
  external contacts are for).

### 4.2 Storage — a new `kelabo-<env>-contacts` table

Decision: a **dedicated table**, chosen for semantic clarity over reusing the
`kelabos` partition.

Cost acknowledged (this is the deploy-ordering hazard `AGENTS.md` names): the
table must exist **before** the code that reads it ships, or the first request is
a runtime `ResourceNotFoundException`, not a deploy error. So the infra deploy
(`make infra` / `cdk deploy <prefix>-ddb`) precedes the REST + Gateway code
deploy for this phase.

Five coordinated edits, in order:

1. `config/loadConfig.mjs` — derive `names.contacts = kelabo-${endpoint}-contacts`,
   and a new derived `contacts: { external: false }` block.
2. `infra/lib/dynamodb-stack.js` — create it: PK `PK` (S), SK `SK` (S),
   `timeToLiveAttribute: "ttl"`, PITR on, PAY_PER_REQUEST, `RemovalPolicy.RETAIN`.
   **No GSI** (see key design). Add to `this.tables` and a `CfnOutput`.
3. `infra/lib/lambda-stack.js` — `KELABO_TABLE_CONTACTS` env +
   `grantReadWriteData`.
4. `infra/lib/gateway-ecs-stack.js` — `KELABO_TABLE_CONTACTS` env +
   **`grantReadData` only** (the Gateway reads accepted peers to scope presence;
   it must never mutate a link).
5. `rest-api/src/config.js` **and** `gateway/src/config.js` — add to **both**
   `fromEnv()` and `fromBase()`.

### 4.3 Key design

One partition per owner, `PK = CONTACT#<ownerEmail>`, holding two item kinds
distinguished by SK prefix — favourites (one-way) and external links (mirrored).

**Favourite — one row, owned solely by the favouriter:**

```
PK = CONTACT#<ownerEmail>
SK = FAV#<peerEmail>
{
  owner, peer,
  tenantId,        // == peerTenantId; a favourite is always same-tenant
  createdAt
}
```

- `Query PK = CONTACT#<me>, begins_with(SK, "FAV#")` lists my favourites. There is
  **no** row on the peer's side and **no** query that reveals who favourited them —
  that privacy is structural, not a rule.
- Favourite is one `PutItem` (conditioned `attribute_not_exists` so a double-add
  is idempotent-safe); unfavourite is one `DeleteItem`. **No transaction** — a
  one-way marker cannot be half-written.

**External link — mirrored pair (§0-gated):**

```
PK = CONTACT#<ownerEmail>
SK = PEER#<peerEmail>
{
  owner, peer,
  state: "outgoing" | "incoming" | "accepted",
  createdAt, respondedAt?,
  tenantId,        // owner's tenant
  peerTenantId,
  ttl?             // only set on decline cleanup grace, normally absent
}
```

A link is **two rows**, one from each side's point of view. Because it is
mirrored, `Query PK = CONTACT#<me>, begins_with(SK, "PEER#")` answers **both**
"who do I watch" and "who watches me" — no GSI needed.

**Every external mutation is a single `TransactWriteCommand` over both rows.** A
half-written link is a contact who sees you but whom you cannot see, and that is
unfixable from the UI — so it must never be possible. (Favourites, being one row,
need no transaction.)

External state machine (both rows move together):

| Action | My row | Their row |
|---|---|---|
| I request | `outgoing` | `incoming` |
| They accept | `accepted` | `accepted` |
| They decline | *deleted* | *deleted* |
| Either removes | *deleted* | *deleted* |

### 4.4 Routes

**Favourites (same-org, always available):**

| Route | Effect |
|---|---|
| `GET /contacts` | `{ favourites:[{email,displayName}], externalEnabled, external:[…], incoming:[…], outgoing:[…] }`. `favourites` are the pinned colleagues (resolved to display names via `users`); it is the org list the SPA shows. |
| `POST /contacts/favourites` `{email}` | favourite a colleague. `409 not_a_colleague` if the address is not same-tenant; rejects self; idempotent on an existing favourite |
| `DELETE /contacts/favourites/:email` | unfavourite. Silent, one `DeleteItem`; `204` even if it was not favourited (idempotent) |

Favourite state is surfaced **on search**, so it can be toggled from a result and
from the kelabo room without a separate lookup: `GET /people/search?q=` gains
`favourited: boolean` per suggestion (and presence, §5). This is the only change
to the existing search route.

**External contacts (§0-gated — `501 external_contacts_unavailable` while off):**

| Route | Effect |
|---|---|
| `POST /contacts` `{email}` | create pair (mine `outgoing`, theirs `incoming`). `409 already_a_colleague` if same tenant; `409 contact_exists` if a row exists; rejects self |
| `POST /contacts/:email/accept` | both rows → `accepted` (must currently be `incoming`) |
| `POST /contacts/:email/decline` | delete both |
| `DELETE /contacts/:email` | delete both — symmetric disconnection. `409 cannot_remove_colleague` if same tenant |

`:email` is URL-encoded; the existing `compile()`/`route()` matcher accepts it as
a single `[^/]+` segment. Route order matters: `/contacts/favourites` and
`/contacts/favourites/:email` register **before** `/contacts/:email/*` so the
literal `favourites` segment is not read as a peer email.

`GET /people/search` stays the invite autocomplete (capped at 8), now also the
contact-search surface. For a fuller directory a paginated `db.listUsersByTenant`
(the existing one discards `LastEvaluatedKey`) can back a "browse all" view, but
the primary flow the user described is search, which already exists.

### 4.5 SPA

- New `routes/Contacts.jsx`:
  - **Favourites** list (only pinned colleagues), each with a presence dot (§5)
    and an unfavourite (star-filled) control.
  - A **search box** over `api.searchPeople(q)`; each result shows presence and a
    favourite/unfavourite toggle reflecting `favourited`. Adding from a result is
    one `POST /contacts/favourites`.
  - When `externalEnabled`, external / incoming / outgoing sections below.
- **Kelabo room:** in the participant list / on a tile, a same-org participant
  (not a guest, `isGuest === false`, and not yourself) gets a favourite toggle
  calling the same endpoints. The room already knows each participant's identity;
  it needs the caller's own favourites to render the initial state — fetched once
  via `GET /contacts` when the room mounts, or piggybacked on the presence
  snapshot the room could subscribe to (kept simple: a one-shot `listContacts`).
- A **Contacts** `NavLink` in `AppShell.jsx` using the existing `users` icon.
- `api.js`: `listContacts`, `favouriteContact(email)`,
  `unfavouriteContact(email)`, and (external, §0-gated) `addContact`,
  `acceptContact`, `declineContact`, `removeContact`.

### 4.6 Docs to update when built

`08-database.md` (new table, both item shapes `FAV#`/`PEER#`), `ARCHITECTURE.md`
(external contacts require multi-domain/open signup and are inert until
then; favourites are private one-way markers), `02-rest-api.md` (favourite +
external routes, and the `favourited` field on `/people/search`), `01-spa.md`
(the Contacts screen and the room favourite affordance).

---

## 5. Presence

### 5.1 The split — REST owns the roster, the Gateway owns liveness

Exactly the split that already exists for RTC: the durable "who *may* be present"
(the tenant directory + accepted contacts) is REST/DynamoDB; the ephemeral "who
*is* connected right now" is the single Gateway task's in-process state, rebuilt
as tabs reconnect. **Nothing about presence is persisted.**

### 5.2 New Gateway state

```
state.presence        : Map<identity, { tenantId, streams:Set<res>, inKelabo:boolean }>
state.presenceByTenant: Map<tenantId, Set<identity>>
```

### 5.3 The endpoint — first non-kelabo-scoped browser route

`GET /presence/stream` — an SSE stream authenticated by the **`kelabo_session`
cookie**, not the participant cookie.

- That cookie already reaches the gateway host (`Domain=.<portalDomain>`,
  `SameSite=Lax`, portal and gateway share a registrable domain) and is verifiable
  there with the same signing key.
- New `verifySessionCookie` in `gateway/src/cookies.js`, requiring
  `kind === "identity"` + `identity` + `tenantId`. Per the "`aud` is the only
  separator" rule, it must be structurally unable to accept an agent or internal
  JWT — it is, because `verifyAppJwt` requires `payload.sub` and no cookie has one.
- Add `/presence/stream` to the CORS path set in `server.js`.

### 5.4 Wire (`event: presence`)

- On connect **and every reconnect**:
  `{ kind:"snapshot", online:[{ identity, inKelabo }] }`.
  **The snapshot is the recovery mechanism** — unlike the board stream there is no
  REST backfill and no `Last-Event-ID`; a fresh snapshot re-syncs everything.
- Deltas: `{ kind:"online", identity, inKelabo }`,
  `{ kind:"offline", identity }`, `{ kind:"busy", identity, inKelabo }`.

**No display names on the wire.** The Gateway has no `users` access by design; the
SPA already has names from `GET /contacts`, which is authoritative. Identities
only.

### 5.5 Fan-out scope

Computed once when a subscriber connects:

- everyone in the **same `tenantId`** — presence inside a domain is already public
  there (the invite picker states "everyone in a domain can see everyone else in
  it"),
- **plus** `accepted` external peers read from `CONTACT#<identity>` — read only
  when `config.contacts.external` is on.

**Favourites do not narrow presence scope.** A favourite is a private *view*
filter (which colleagues you pin), not a presence subscription — the SPA already
receives presence for the whole tenant and simply shows dots against the
favourites and search results it renders. So favouriting/unfavouriting never
touches the Gateway and never emits a presence event. `FAV#` rows are also never
read by the Gateway (its contacts grant reads `PEER#` rows only).

### 5.6 Liveness — copy the RTC mechanism, including its fix

`presence.js` `subscribe`/`unsubscribe` copy `sseHub.subscribe` exactly,
**including the reference-counting fix**: `offline` fires only when an identity's
*last* stream closes, counted by **re-reading the current set** rather than
closing over the one captured at subscribe time — otherwise an EventSource
reconnect (old close lands after new subscribe) marks a present colleague offline.

No heartbeat/timeout on presence itself — TCP + the ALB's 240 s idle timeout is
the signal, with a 25 s `: ping` comment to stay under it. Same as every other
stream.

`inKelabo` is derived for free: whether the identity holds any
`/caption/replies` subscription. Useful for a huddle app — do not ring someone
mid-kelabo without saying so.

### 5.7 SPA

- **`presence/presenceStore.js` — pure, injected clock, imports carry `.js`** —
  plus `spa/test/presence.mjs`. Per `AGENTS.md` this is *not* optional polish: a
  pure reducer is the only way any of this is testable under plain node, because
  everything else needs a live connection.
- `presence/usePresence.js` owns the single EventSource, and
  `presence/PresenceContext.jsx` (`PresenceProvider`) mounts it **once above the
  router** in `App.jsx` — not inside `AppShell`, because the kelabo room lives
  *outside* the shell and must read the same stream rather than open a second
  one. Same rule `useBoard` follows: a layout switch or route change must never
  re-subscribe. A guest (no identity) gets an inert value. The 8 s `listKelabos`
  poll is unchanged.
- Online dots on `Contacts.jsx` (reuse `.sdot-live` / `.sdot-ended`), with an
  "in a kelabo" chip when `inKelabo`. Results and favourites both light up.
- **Fan-out is tenant-wide, not favourite-scoped.** The Gateway announces to
  every same-tenant watcher (presence in a domain is public); favouriting is a
  private *view* filter, so the SPA simply renders dots against the favourites
  and search results it shows. This is why favouriting never touches the Gateway.

### 5.8 Single-task assumption

All of the above is correct **because `desiredCount` is 1**. In-process presence
is globally consistent for exactly that reason. Scaling the Gateway out
("kelabo affinity") breaks it and would require cross-task presence (Redis or a
DynamoDB-backed roster with a reaper) — out of scope, but noted so the assumption
is explicit.

---

## 6. The huddle / ring — ✅ built

"Call" an online contact: send a request, they join by accepting immediately.
Ephemeral, in-process, ~45 s. Built on presence (§5): ring events ride the same
`/presence/stream`, so a person receives a ring on every open tab.

As built:

- **Delivery reuses the presence streams.** `ring_incoming` / `ring_answer` /
  `ring_cancelled` are delivered to a specific identity's tabs via the presence
  hub's per-identity `sendTo` — no new transport, no new browser connection. The
  SPA routes ring events out of `usePresence` to `useRing` (a modal) while the
  presence reducer stays about who-is-online only.
- **Gateway** holds `state.rings: Map<kelaboId, {from, fromName, title,
  targets:Set, answered:Set, expiresAt, timer}>`. `ring` delivers to whichever
  targets are online and returns `{rung, offline}`; a 45 s timer expires
  unanswered targets (`ring_cancelled{reason:"timeout"}` to them,
  `ring_answer{response:"timeout"}` to the ringer). `ringAnswer` relays to the
  ringer and stops the callee's other tabs; `ringCancel` stops every outstanding
  target. Internal endpoints: `POST /internal/kelabos/:id/ring`,
  `/ring/answer`, `/ring/cancel` (internal-JWT, body-carrying).
- **REST owns authorization and target resolution** (`huddle.js`), the one place
  with both the users directory and the contacts table: each target must be a
  same-tenant colleague or an accepted external contact, else `no_contact`.
  - `POST /huddles {invitees, title?}` — start an instant ACTIVE kelabo (reusing
    `kelabos.createKelabo`), write one `INVITE#` row per target, ring them →
    `{kelaboId, joinUrl, rung, offline}`.
  - `POST /kelabos/:id/ring {invitees}` — ring more people into a kelabo that
    is already live; caller must be the host or a participant.
  - `POST /kelabos/:id/ring/answer {response}` — an invited callee accepts /
    declines (proven by their `INVITE#` row).
  - `POST /kelabos/:id/ring/cancel` — the host hangs up.
- **Offline targets are not rung** and come back in `offline[]`. The kelabo and
  its link still exist, so they can join later. No email for an ad-hoc huddle.
- **SPA.** A `PresenceProvider` above the router (uses `useNavigate`, so it sits
  *inside* `BrowserRouter`) shows an incoming-ring **modal** (`RingModal`) on any
  page + an OS notification via `notify.js` with its own `kelabo-ring` tag (no
  longer colliding with the board's). Accept → `answerRing` → `joinKelabo` →
  `/m/:id`, skipping the lobby. **Dialling:** a call button on every online
  contact in `Contacts.jsx` (`POST /huddles`), and an **Add people** menu in the
  room (`AddPeople.jsx`, `POST /kelabos/:id/ring`) listing online contacts not
  already present. No ringtone (no audio asset in the repo; autoplay policy).

Original design shape — retained for reference only, superseded by the "As
built" description above:

- A huddle is an ordinary **active** kelabo — same partition, same join link,
  same room — and needs no new kelabo concept. One `INVITE#` row per target so
  `mayAttach` and the agent briefing keep working.
- `POST /huddles {invitees:[email] ≤20, title?}` →
  `{ kelaboId, joinUrl, rung:[], offline:[] }`.
  `POST /kelabos/:id/ring/answer {response}`, `POST /kelabos/:id/ring/cancel`.
- **Authorization lives in REST** (only side with both `users` and contacts):
  each target must be same-tenant or an `accepted` contact, else `403 no_contact`.
  The Gateway is told whom to ring and does not re-derive it.
- Gateway `state.rings: Map<kelaboId, {from, targets:Set, expiresAt, timer}>`;
  delivery is addressed **per identity** via the existing `sseHub.rtcTo` pattern
  (the one send-to-one-participant primitive). On timeout: `ring_cancelled` to
  targets, `ring_answer{response:"timeout"}` to the host.
- **Offline targets are not rung** and come back in `offline[]`. The kelabo and
  its link still exist, so they can join later. (Decision: no email for an ad-hoc
  huddle — it would arrive about a kelabo that is already over.)
- SPA: a `RingProvider` above the router (like `ToastProvider`) so an incoming
  ring surfaces on any shell page; accept → `joinKelabo` → `/m/:id`, skipping the
  lobby. Modal dialog **+ OS notification** via `notify.js` with its **own tag**
  (today everything collapses onto `tag: 'kelabo-board'`). No ringtone (there is
  no audio asset in the repo and autoplay policy makes it non-trivial).

---

## 7. Deploy ordering

**The contacts table must exist before the code that reads it:** the
`kelabo-<env>-contacts` table must exist before the Lambda/Gateway code that reads
it. Run `make infra env=dev` (or `cdk deploy <prefix>-ddb`) **before**
`make backend` / `make gateway`. A missing table is a runtime
`ResourceNotFoundException` on the first `/contacts` call, not a deploy error.

Per-phase gates (`AGENTS.md` "Verify"): `make check`, then the affected package's
`npm test` (`contracts`, `rest-api`, `gateway`, `spa`), `cd spa && npm run build`
for any JSX, and `make synth env=dev` for any infra change. New pure modules ship
with their own node test (`spa/test/presence.mjs`, contacts invariants in
`rest-api/test/smoke.mjs`, cancel/reschedule and status-audit cases likewise).

---

## 8. Pre-existing issues this work touches

1. **Staging cookie scope is broken.** Staging uses portal `staging` and gateway
   `staging-gw` — *siblings*, not nested — so `Domain=.staging.example.com` is
   never sent to `staging-gw.example.com`. The participant cookie already fails
   there today, and the presence session cookie would too. Dev (`dev`/`gw.dev`)
   and prod (`""`/`gw`) nest correctly. Fix is a one-line config change to
   `gw.staging`. Flagged; fix folded into the infra work if approved.
2. **`tenantStatus` on end is inconsistent** — REST removes it, the Gateway sets
   `#ended`, on the same end. Cancel sets `#cancelled` consistently; the pre-existing
   `ended` discrepancy is left alone to avoid widening the change.
</content>
</invoke>
