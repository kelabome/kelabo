import {
  PutCommand,
  GetCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  CREDENTIAL_SK,
  credentialPk,
  mcpSecretSk,
  parseCredential,
} from "@kelabo/contracts/credentials";
import { OPCONFIG_PK } from "@kelabo/contracts/opconfig";

const kelabosTable = (c) => c.config.tableNames.kelabos;
const historyTable = (c) => c.config.tableNames.history;
const mcpTable = (c) => c.config.tableNames.mcp;
const credentialsTable = (c) => c.config.tableNames.credentials;
const configTable = (c) => c.config.tableNames.config;

/**
 * Every published operational-config version (contracts/src/opconfig.js).
 *
 * Read-only, and Query rather than Scan for two reasons: the admin roster lives
 * in the same table and this task has no business reading it, and IAM fences
 * this to the `OPCONFIG` partition — a Scan cannot be constrained by
 * `dynamodb:LeadingKeys` at all and would be denied.
 *
 * A missing table name returns nothing, which the cache reads as "a deployment
 * that has published nothing" and answers from this service's own environment
 * config. That is what keeps an environment deployed before this table existed
 * running exactly as it did.
 */
export async function listOpConfigs(c) {
  if (!configTable(c)) return [];
  const out = await c.db.send(
    new QueryCommand({
      TableName: configTable(c),
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": OPCONFIG_PK },
    })
  );
  return out.Items || [];
}

/**
 * A supplier credential, by slot.
 *
 * IAM lets this task read `CRED#llm` and `CRED#rtc` and nothing else — one
 * partition per slot is what makes that expressible as a `LeadingKeys`
 * condition, the same way the Secrets Manager prefix grants worked. There is
 * no write of any kind: rotating a credential is the control plane's.
 *
 * A missing table or a missing item returns null, and every caller treats that
 * as "this capability is not configured" — the behaviour a missing secret gave.
 */
export async function getCredential(c, slot) {
  if (!credentialsTable(c)) return null;
  const out = await c.db.send(
    new GetCommand({ TableName: credentialsTable(c), Key: { PK: credentialPk(slot), SK: CREDENTIAL_SK } })
  );
  return out.Item?.value ? parseCredential(out.Item.value) : null;
}

export const kelaboPk = (kelaboId) => `KELABO#${kelaboId}`;
export const pad = (n, w = 12) => String(Math.max(0, Math.floor(n))).padStart(w, "0");
// Exported for gateway/src/journeys.js's own TL#/CONTRIBUTOR# writes (docs
// 20 §4.1/§10) — same non-secret same-millisecond tie-breaker, not a second
// implementation of it.
export const randSeq = () => Math.random().toString(36).slice(2, 8).padEnd(6, "0");

export async function getMeta(c, kelaboId) {
  const out = await c.db.send(
    new GetCommand({ TableName: kelabosTable(c), Key: { PK: kelaboPk(kelaboId), SK: "META" } })
  );
  return out.Item ?? null;
}

// `null` means REMOVE the attribute, matching rest-api's `updateKelaboMeta`.
// Two helpers writing the same item with different meanings for the same value
// is how a flag comes back from the dead: SET-to-null still satisfies
// `attribute_exists`, and reads as absent to some callers and present to others.
export async function updateMeta(c, kelaboId, fields) {
  const names = {};
  const values = {};
  const sets = [];
  const removes = [];
  let i = 0;
  for (const [k, v] of Object.entries(fields)) {
    names[`#f${i}`] = k;
    if (v === null) {
      removes.push(`#f${i}`);
    } else {
      values[`:v${i}`] = v;
      sets.push(`#f${i} = :v${i}`);
    }
    i++;
  }
  if (!sets.length && !removes.length) return;
  const expr = [sets.length ? `SET ${sets.join(", ")}` : "", removes.length ? `REMOVE ${removes.join(", ")}` : ""]
    .filter(Boolean)
    .join(" ");
  await c.db.send(
    new UpdateCommand({
      TableName: kelabosTable(c),
      Key: { PK: kelaboPk(kelaboId), SK: "META" },
      UpdateExpression: expr,
      ExpressionAttributeNames: names,
      ...(sets.length ? { ExpressionAttributeValues: values } : {}),
    })
  );
}

// `ttl` is for rows written to a kelabo that has already ended: the end-time
// TTL sweep (`stampKelaboTtl`) has run or is about to, and a row landing after
// it — a caption a browser flushes as it disconnects — would otherwise outlive
// the partition forever. Live-kelabo rows carry no TTL; the sweep stamps them.
export async function putUtt(c, utt, { ttl } = {}) {
  const sk = `UTT#${pad(utt.tStart)}#${randSeq()}`;
  await c.db.send(
    new PutCommand({
      TableName: kelabosTable(c),
      Item: {
        PK: kelaboPk(utt.kelaboId),
        SK: sk,
        speaker: utt.speaker,
        text: utt.text,
        tStart: utt.tStart,
        tEnd: utt.tEnd,
        clientId: utt.clientId,
        tenantId: utt.tenantId,
        ...(utt.source ? { source: utt.source } : {}),
        ...(typeof utt.at === "number" ? { at: utt.at } : {}),
        ...(utt.messageId ? { messageId: utt.messageId } : {}),
        ...(ttl ? { ttl } : {}),
      },
    })
  );
  return sk;
}

export async function putContrib(c, contribution) {
  const sk = `CONTRIB#${pad(contribution.at, 13)}#${randSeq()}`;
  await c.db.send(
    new PutCommand({
      TableName: kelabosTable(c),
      Item: {
        PK: kelaboPk(contribution.kelaboId),
        SK: sk,
        id: contribution.id,
        tag: contribution.tag,
        kind: contribution.kind,
        to: contribution.to,
        title: contribution.title,
        markdown: contribution.markdown,
        sources: contribution.sources,
        author: contribution.author,
        origin: contribution.origin,
        // Which local coding agent produced it, and its owner's label. Display
        // only, but persisted so the board reads the same after a reload as it
        // did live (docs 16).
        runtime: contribution.runtime,
        agentLabel: contribution.agentLabel,
        at: contribution.at,
        tenantId: contribution.tenantId,
      },
    })
  );
  return sk;
}

export async function queryKelaboItems(c, kelaboId, skPrefix, { limit, desc = false, before } = {}) {
  const out = await c.db.send(
    new QueryCommand({
      TableName: kelabosTable(c),
      // `before` pages backwards through a partition: BETWEEN is the only way
      // to bound the sort key alongside its prefix in one key condition, and
      // it is INCLUSIVE — callers drop the row equal to their own cursor.
      KeyConditionExpression: before
        ? "PK = :pk AND SK BETWEEN :sk AND :before"
        : "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: {
        ":pk": kelaboPk(kelaboId),
        ":sk": skPrefix,
        ...(before ? { ":before": before } : {}),
      },
      ScanIndexForward: !desc,
      ...(limit ? { Limit: limit } : {}),
    })
  );
  return out.Items ?? [];
}

export const queryUtt = (c, kelaboId, opts) => queryKelaboItems(c, kelaboId, "UTT#", opts);
export const queryContrib = (c, kelaboId, opts) => queryKelaboItems(c, kelaboId, "CONTRIB#", opts);

/**
 * Stamp the retention TTL onto every remaining row of a kelabo's partition.
 *
 * `endKelabo` writes `ttl` on META, but the partition holds more than META:
 * without this, UTT#, CONTRIB#, MINUTES, PROMOTION and INVITE# rows outlive
 * it forever — unreachable once META expires, yet still holding transcript
 * text and invitee email addresses, while the published retention policy
 * says a kelabo is gone `retentionDays` after it ends. The record in S3 is
 * the copy that is kept; these rows are the working copy, and they expire
 * with the kelabo.
 *
 * JOURNEY# mirrors are deliberately skipped: a link outlives the kelabo's
 * own expiry so a record can still say which journeys it belongs to (docs
 * 20 §4.3) — only an unlink or a purge removes one.
 *
 * Returns the number of rows stamped. Idempotent: re-stamping the same TTL
 * is a no-op in effect, so a retried end costs writes, not correctness.
 */
export async function stampKelaboTtl(c, kelaboId, ttl) {
  let cursor;
  let stamped = 0;
  do {
    const out = await c.db.send(
      new QueryCommand({
        TableName: kelabosTable(c),
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": kelaboPk(kelaboId) },
        ProjectionExpression: "PK, SK",
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      })
    );
    const rows = (out.Items ?? []).filter(
      (r) => r.SK !== "META" && !String(r.SK).startsWith("JOURNEY#")
    );
    // Bounded parallelism: a long kelabo has thousands of UTT# rows, and this
    // runs post-end in the background — small chunks keep it from competing
    // with live rooms for the table.
    for (let i = 0; i < rows.length; i += 20) {
      const chunk = rows.slice(i, i + 20);
      await Promise.all(
        chunk.map((r) =>
          c.db.send(
            new UpdateCommand({
              TableName: kelabosTable(c),
              Key: { PK: r.PK, SK: r.SK },
              // `#ttl`: TTL is a DynamoDB reserved word — a bare `ttl = :ttl`
              // fails the whole update with a ValidationException.
              UpdateExpression: "SET #ttl = :ttl",
              ExpressionAttributeNames: { "#ttl": "ttl" },
              ExpressionAttributeValues: { ":ttl": ttl },
            })
          )
        )
      );
      stamped += chunk.length;
    }
    cursor = out.LastEvaluatedKey;
  } while (cursor);
  return stamped;
}

// Retroactively rewrite the speaker label on all stored utterances for a kelabo.
// Returns the number of rows updated.
export async function renameSpeakerUtts(c, kelaboId, from, to) {
  const items = await queryUtt(c, kelaboId);
  let updated = 0;
  for (const it of items) {
    if (it.speaker !== from) continue;
    await c.db.send(
      new UpdateCommand({
        TableName: kelabosTable(c),
        Key: { PK: it.PK, SK: it.SK },
        UpdateExpression: "SET #s = :to",
        ExpressionAttributeNames: { "#s": "speaker" },
        ExpressionAttributeValues: { ":to": to },
      })
    );
    updated++;
  }
  return updated;
}

export async function getPromotion(c, kelaboId) {
  const out = await c.db.send(
    new GetCommand({ TableName: kelabosTable(c), Key: { PK: kelaboPk(kelaboId), SK: "PROMOTION" } })
  );
  return out.Item ?? null;
}

export async function putPromotion(c, kelaboId, promotion) {
  await c.db.send(
    new PutCommand({
      TableName: kelabosTable(c),
      Item: { PK: kelaboPk(kelaboId), SK: "PROMOTION", ...promotion },
    })
  );
}

export async function putMinutes(c, minutes) {
  await c.db.send(
    new PutCommand({
      TableName: kelabosTable(c),
      Item: { PK: kelaboPk(minutes.kelaboId), SK: "MINUTES", ...minutes },
    })
  );
}

export async function getMinutes(c, kelaboId) {
  const out = await c.db.send(
    new GetCommand({ TableName: kelabosTable(c), Key: { PK: kelaboPk(kelaboId), SK: "MINUTES" } })
  );
  return out.Item ?? null;
}

/**
 * Every kelabo whose `tenantStatus` ends in `#<status>`.
 *
 * One configured tenant is a Query on the GSI. **No configured tenant is not
 * one tenant called `""`** — it is a deployment where the tenant is the
 * verified email domain and there are as many as there are users. Both callers
 * used to build the key as `` `${tenant}#active` `` regardless, so on the SaaS
 * they asked for the partition `"#active"`, which nothing is ever in: the
 * sweeper saw zero kelabos, every time, and the entire recovery path for a
 * failed settlement was dead while looking perfectly healthy in the logs.
 *
 * Across tenants it is a Scan of the index, filtered in code. The index holds
 * one row per kelabo and this runs on a 15-minute timer, so the cost is small
 * and bounded; `endsWith` is done here because DynamoDB has no such operator.
 *
 * `tenantId` is deliberately the BOOTSTRAP value, not the published
 * `allowedEmailDomain` (docs 23 §7.3). Rows are stamped with the *creator's*
 * email domain at creation, so a deployment that publishes a corrected domain
 * has rows under both — and a sweeper that followed the published value would
 * silently stop seeing everything stamped before the publish. The bootstrap is
 * wrong in the same way but stable; a deployment changing its domain should
 * expect the sweep to need the multi-tenant Scan path, not a config read.
 */
async function kelabosByStatus(c, status) {
  const tenant = c.config.tenantId;
  if (tenant) {
    const out = await c.db
      .send(
        new QueryCommand({
          TableName: kelabosTable(c),
          IndexName: "status-index",
          KeyConditionExpression: "tenantStatus = :ts",
          ExpressionAttributeValues: { ":ts": `${tenant}#${status}` },
        })
      )
      .catch(() => ({ Items: [] }));
    return out.Items ?? [];
  }
  const suffix = `#${status}`;
  const items = [];
  let ExclusiveStartKey;
  do {
    const out = await c.db
      .send(
        new ScanCommand({
          TableName: kelabosTable(c),
          IndexName: "status-index",
          ExclusiveStartKey,
        })
      )
      .catch(() => ({ Items: [] }));
    for (const i of out.Items ?? []) if (String(i.tenantStatus ?? "").endsWith(suffix)) items.push(i);
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

export async function queryActiveKelabos(c) {
  return kelabosByStatus(c, "active");
}

export async function findActiveKelaboHostedBy(c, identity, tenant) {
  const metas = tenant
    ? await queryActiveKelabos(c)
    : [];
  for (const m of metas) {
    if (m.hostIdentity === identity) return m.PK?.slice("KELABO#".length) ?? m.kelaboId;
  }
  return "";
}

/** The invitation rows written when a kelabo was scheduled. Used to decide
 *  whether an agent may attach: being invited to a kelabo is enough, since
 *  preparing for one you were invited to is the ordinary case. */
export const queryInvites = (c, kelaboId) => queryKelaboItems(c, kelaboId, "INVITE#");

/**
 * A subscriber's accepted external contacts (docs 18 §4/§5). Read-only — the
 * Gateway's grant is GetItem/Query, never write. Returns the peer emails so
 * presence fan-out can reach cross-org contacts on top of same-tenant
 * colleagues. Only `PEER#` rows count (favourites, `FAV#`, are private and never
 * read here). Missing table or a failed read yields an empty list: contact
 * presence degrades to same-tenant rather than erroring.
 */
export async function queryAcceptedContacts(c, identity) {
  const table = c.config.tableNames.contacts;
  if (!table) return [];
  try {
    const out = await c.db.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": `CONTACT#${identity}`, ":sk": "PEER#" },
      })
    );
    return (out.Items ?? []).filter((r) => r.state === "accepted").map((r) => r.peer);
  } catch {
    return [];
  }
}

/**
 * Is a developer's agent token still live? Read-only, and only ever called once
 * per tunnel connection — the JWT itself carries signature, audience and expiry,
 * so this exists purely so "revoke" in Settings means something before the token
 * expires (docs 16 §6).
 */
export async function isAgentTokenRevoked(c, jti) {
  const table = c.config.tableNames.refresh;
  // An older deployment has no table name plumbed through. Fail closed on the
  // revocation check rather than silently accepting every token forever.
  if (!table) return true;
  const out = await c.db.send(new GetCommand({ TableName: table, Key: { PK: `AGT#${jti}` } }));
  const row = out.Item;
  if (!row) return true;
  if (row.revoked) return true;
  return typeof row.expiresAt === "number" && row.expiresAt <= Date.now();
}

export async function putHistoryRow(c, row) {
  await c.db.send(new PutCommand({ TableName: historyTable(c), Item: row }));
}

/**
 * Mark a record as having no minutes, and say why.
 *
 * The difference between "not written yet" and "never going to be" is invisible
 * from `hasMinutes: false` alone, and the record page rendered the first — a
 * spinner and "they'll appear here shortly" — for a kelabo whose assistant was
 * switched off and whose minutes nothing was ever going to generate.
 *
 * `reason` carries the *second* distinction, which cost a real record its
 * minutes: "never going to be" and "this attempt failed" are both "no minutes"
 * on the wire, and the page guessed. It guessed wrong — a kelabo whose LLM call
 * came back unusable was told the assistant had been off, and offered no way to
 * try again. The gateway already logs the reason; this is the same string, put
 * where the reader can act on it.
 *
 * An update rather than a full re-put: the row is already there and complete,
 * and rebuilding it here would mean a second copy of its shape drifting from
 * the one that writes it.
 */
export async function markHistoryMinutesSkipped(c, archiveId, reason = "") {
  await c.db.send(
    new UpdateCommand({
      TableName: historyTable(c),
      Key: { archiveId },
      UpdateExpression: reason ? "SET minutesSkipped = :t, minutesSkippedReason = :r" : "SET minutesSkipped = :t",
      ExpressionAttributeValues: { ":t": true, ...(reason ? { ":r": reason } : {}) },
    })
  );
}

export async function putParticipantIndex(c, archive, participant, { hasMinutes = false, titleGenerated = false } = {}) {
  await c.db.send(
    new PutCommand({
      TableName: historyTable(c),
      Item: {
        archiveId: `PARTICIPANT#${participant.identity}#${archive.archiveId}`,
        participantIdentity: participant.identity,
        kelaboId: archive.kelaboId,
        title: archive.title,
        ...(titleGenerated ? { titleGenerated: true } : {}),
        host: archive.host,
        startedAt: archive.startedAt,
        endedAt: archive.endedAt,
        participantCount: (archive.participants || []).length || undefined,
        boardCount: (archive.board || []).length || undefined,
        hasMinutes,
        ...(archive.isCall ? { isCall: true } : {}),
        tenantId: archive.tenantId,
      },
    })
  );
}

/**
 * A person's own past kelabos, newest first (notes #3).
 *
 * Reads the same `participant-index` the SPA's kelabo list reads, so the
 * assistant's memory is exactly the set of kelabos that person can already
 * open and read — no wider. The index is keyed by `participantIdentity`, so
 * there is no query here that could reach a kelabo they were not in, even by
 * accident.
 *
 * `exclude` drops the kelabo in progress: it is not history, and its own
 * transcript is already the agent's whole conversation.
 */
export async function queryPastKelabos(c, identity, { limit = 8, exclude } = {}) {
  if (!identity) return [];
  const out = await c.db.send(
    new QueryCommand({
      TableName: historyTable(c),
      IndexName: "participant-index",
      KeyConditionExpression: "participantIdentity = :p",
      ScanIndexForward: false,
      // One over, so excluding the current kelabo cannot shorten the list.
      Limit: limit + 1,
      ExpressionAttributeValues: { ":p": identity },
    })
  );
  return (out.Items ?? []).filter((i) => i.kelaboId && i.kelaboId !== exclude).slice(0, limit);
}

// Legacy cleanup only: HOSTACTIVE#<host> GUARD rows written before hosts could
// run several live kelabos (pre-2026-07-31). Nothing writes or reads them any
// more; deleting on end drains the old rows away.
export async function deleteHostActive(c, hostIdentity) {
  if (!hostIdentity) return;
  await c.db.send(
    new DeleteCommand({
      TableName: kelabosTable(c),
      Key: { PK: `HOSTACTIVE#${hostIdentity}`, SK: "GUARD" },
    })
  ).catch(() => {});
}

export async function putArchiveObject(c, key, archive) {
  await c.s3.send(
    new PutObjectCommand({
      Bucket: c.config.archiveBucket,
      Key: key,
      Body: JSON.stringify(archive),
      ContentType: "application/json",
    })
  );
}

/**
 * The archived record, or `null` if it is not there or unreadable.
 *
 * The Gateway writes this object and, until now, never read it back — which is
 * why regenerating minutes for an already-ended kelabo could not work: the
 * record page reads `minutes` out of THIS object, so minutes written anywhere
 * else are invisible no matter how correct they are.
 */
export async function getArchiveObject(c, key) {
  try {
    const res = await c.s3.send(new GetObjectCommand({ Bucket: c.config.archiveBucket, Key: key }));
    return JSON.parse(await res.Body.transformToString());
  } catch (err) {
    // Logged, not swallowed. "Absent" and "present but unreadable" produce the
    // same `null` here and mean opposite things to the caller — the first is a
    // kelabo that has not been archived yet, the second is a permissions or
    // parse failure that will make a regeneration quietly write to nowhere.
    // The task role was write-only when this was first added, so the very first
    // real retry took the wrong branch and reported success.
    c.logError?.("archive_object_read_failed", err, { key });
    return null;
  }
}

export async function queryMcpScope(c, scopePk) {
  if (!mcpTable(c)) return [];
  const out = await c.db
    .send(
      new QueryCommand({
        TableName: mcpTable(c),
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": scopePk, ":sk": "SERVER#" },
      })
    )
    // Failing open — a kelabo still starts, without its tools — but **not
    // silently**. This used to be a bare `.catch(() => …)`, which made an
    // unreadable partition indistinguishable from an empty one: the agent
    // simply had no servers, and there was no error at any level to look at.
    // That is the same shape as the opencode plugin-spec bug (AGENTS.md), and
    // it matters more now that a *shared* catalogue can be the missing one.
    .catch((err) => {
      c.logError?.("mcp_scope_read_failed", err, { scopePk });
      return { Items: [] };
    });
  return out.Items ?? [];
}

// ---- MCP credentials ------------------------------------------------------
// The gateway is the only component that sees a 401 from an MCP server mid-call,
// so it owns the refresh grant and therefore needs WRITE access to TOKEN# items
// (see gateway-ecs-stack.js). It never touches SERVER# or SECRET# items — those
// stay rest-api-owned, and this task only reads them.

export async function getMcpToken(c, scopePk, name) {
  if (!mcpTable(c)) return null;
  const out = await c.db
    .send(new GetCommand({ TableName: mcpTable(c), Key: { PK: scopePk, SK: `TOKEN#${name}` } }))
    .catch(() => ({ Item: null }));
  if (!out.Item) return null;
  const { PK, SK, ...token } = out.Item;
  return token;
}

export async function putMcpToken(c, scopePk, name, token) {
  if (!mcpTable(c)) return;
  await c.db.send(
    new PutCommand({ TableName: mcpTable(c), Item: { PK: scopePk, SK: `TOKEN#${name}`, ...token } })
  );
}

/**
 * A host's pasted bearer token for one MCP server.
 *
 * Read-only here, like `SERVER#` items: the token is written by rest-api when
 * the host pastes it and this task only ever presents it. It sits in the same
 * partition as the server it authenticates, under the same customer-managed
 * key as the OAuth tokens for servers that use those instead.
 */
export async function getMcpSecret(c, scopePk, name) {
  if (!mcpTable(c)) return null;
  const out = await c.db
    .send(new GetCommand({ TableName: mcpTable(c), Key: { PK: scopePk, SK: mcpSecretSk(name) } }))
    .catch(() => ({ Item: null }));
  return out.Item?.token ?? null;
}

/** The deployment-wide dynamic client registration for an authorization server. */
export async function getMcpClient(c, issuer) {
  if (!mcpTable(c)) return null;
  const out = await c.db
    .send(new GetCommand({ TableName: mcpTable(c), Key: { PK: "MCP#client", SK: `AS#${issuer}` } }))
    .catch(() => ({ Item: null }));
  if (!out.Item) return null;
  const { PK, SK, ...reg } = out.Item;
  return reg;
}
