import {
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { PutObjectCommand } from "@aws-sdk/client-s3";

const kelabosTable = (c) => c.config.tableNames.kelabos;
const historyTable = (c) => c.config.tableNames.history;
const mcpTable = (c) => c.config.tableNames.mcp;

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

export async function putUtt(c, utt) {
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

export async function queryActiveKelabos(c) {
  const tenant = c.config.tenantId;
  if (tenant) {
    const out = await c.db.send(
      new QueryCommand({
        TableName: kelabosTable(c),
        IndexName: "status-index",
        KeyConditionExpression: "tenantStatus = :ts",
        ExpressionAttributeValues: { ":ts": `${tenant}#active` },
      })
    );
    return out.Items ?? [];
  }
  const out = await c.db.send(
    new QueryCommand({
      TableName: kelabosTable(c),
      IndexName: "status-index",
      KeyConditionExpression: "tenantStatus = :ts",
      ExpressionAttributeValues: { ":ts": "#active" },
    })
  ).catch(() => ({ Items: [] }));
  return out.Items ?? [];
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

export async function queryMcpScope(c, scopePk) {
  if (!mcpTable(c)) return [];
  const out = await c.db.send(
    new QueryCommand({
      TableName: mcpTable(c),
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": scopePk, ":sk": "SERVER#" },
    })
  ).catch(() => ({ Items: [] }));
  return out.Items ?? [];
}

// ---- MCP OAuth ------------------------------------------------------------
// The gateway is the only component that sees a 401 from an MCP server mid-call,
// so it owns the refresh grant and therefore needs WRITE access to TOKEN# items
// (see gateway-ecs-stack.js). It never touches SERVER# items — those stay
// rest-api-owned.

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
