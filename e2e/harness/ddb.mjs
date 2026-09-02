// An in-memory DynamoDB **document client**, shared by both services.
//
// WHY AT THIS LEVEL AND NOT AT THE DB-MODULE LEVEL. The unit suites stub two
// different things: `rest-api/test/stubDb.js` reimplements the whole of
// `rest-api/src/db.js`'s interface, while `gateway/test/smoke.mjs` fakes the
// document client underneath it. Neither can be shared with the other, and an
// e2e run needs exactly that — a kelabo the REST API created must be visible to
// the Gateway that serves its captions, because a bug where it is not is
// precisely the kind this suite exists to catch.
//
// The document client is the one seam both sides already accept
// (`createDb({ config, client })` in rest-api/src/db.js:48, `createContainer({ db })`
// in gateway/src/container.js:17), so implementing it once gives both services
// their REAL db modules over one store. The cost is that this file has to know
// what a GSI is; the benefit is that the query semantics under test are the
// ones the code was written against, including sort-key ordering, sparse
// indexes and conditional writes.
//
// Not a general DynamoDB: unsupported constructs throw (see expr.mjs).

import { evaluateCondition, applyUpdate, project } from "./expr.mjs";

/**
 * Key schema per logical table, mirroring infra/lib/dynamodb-stack.js.
 * Keyed by the CONFIG key (`tableNames.<key>`), resolved to real names below,
 * so the two stay together and a renamed table fails loudly rather than
 * silently creating a second empty store.
 */
export const TABLE_SCHEMA = {
  kelabos: {
    pk: "PK",
    sk: "SK",
    indexes: {
      "status-index": { pk: "tenantStatus", sk: "startedAt" },
      "invitee-index": { pk: "inviteKey", sk: "invitedAt" },
    },
  },
  history: {
    pk: "archiveId",
    indexes: { "participant-index": { pk: "participantIdentity", sk: "endedAt" } },
  },
  users: { pk: "PK", indexes: { "tenant-index": { pk: "tenantId", sk: "email" } } },
  otp: { pk: "PK" },
  refresh: { pk: "PK", indexes: { "identity-index": { pk: "identityHash" } } },
  mcp: { pk: "PK", sk: "SK" },
  contacts: { pk: "PK", sk: "SK" },
  credentials: { pk: "PK", sk: "SK" },
  journeys: {
    pk: "PK",
    sk: "SK",
    indexes: {
      "tenant-status-index": { pk: "tenantStatus", sk: "updatedAt" },
      "accessor-index": { pk: "accessorIdentity", sk: "addedAt" },
    },
  },
  config: { pk: "PK", sk: "SK" },
};

class ConditionalCheckFailed extends Error {
  constructor() {
    super("The conditional request failed");
    this.name = "ConditionalCheckFailedException";
  }
}

class TransactionCanceled extends Error {
  constructor(reasons) {
    super("Transaction cancelled");
    this.name = "TransactionCanceledException";
    // Positional, because rest-api/src/db.js:929 reads `CancellationReasons[1]`
    // — a plain list of the failures would pass that check on the wrong item.
    this.CancellationReasons = reasons;
  }
}

const clone = (v) => (v === undefined ? undefined : structuredClone(v));

/**
 * @param {Record<string,string>} tableNames  config.tableNames — the same
 *   object both services are configured with, so a name only exists once.
 */
export function createInMemoryDynamo(tableNames) {
  /** real table name -> schema */
  const schemas = new Map();
  /** real table name -> Map(keyString -> item) */
  const stores = new Map();

  for (const [key, schema] of Object.entries(TABLE_SCHEMA)) {
    const name = tableNames[key];
    if (!name) throw new Error(`config.tableNames.${key} is not set — the harness cannot back it`);
    schemas.set(name, schema);
    stores.set(name, new Map());
  }

  function tableOf(name) {
    const store = stores.get(name);
    if (!store) throw new Error(`unknown table: ${name} (have: ${[...stores.keys()].join(", ")})`);
    return { store, schema: schemas.get(name) };
  }

  /** The primary key as one string. `\u0000` cannot occur in any id we mint. */
  function keyString(schema, item) {
    const pk = item[schema.pk];
    if (pk === undefined) throw new Error(`item is missing partition key ${schema.pk}`);
    return schema.sk ? `${pk}\u0000${item[schema.sk]}` : String(pk);
  }

  function guard(name, key, condition, names, values) {
    if (!condition) return;
    const { store, schema } = tableOf(name);
    const existing = store.get(keyString(schema, key)) ?? null;
    if (!evaluateCondition(condition, existing, names, values)) throw new ConditionalCheckFailed();
  }

  function put(input) {
    const { store, schema } = tableOf(input.TableName);
    guard(input.TableName, input.Item, input.ConditionExpression, input.ExpressionAttributeNames, input.ExpressionAttributeValues);
    // `removeUndefinedValues` is set on the real client; matching it here keeps
    // "wrote undefined" from becoming a stored `undefined` the real table would
    // have rejected outright.
    store.set(keyString(schema, input.Item), JSON.parse(JSON.stringify(input.Item)));
    return {};
  }

  function update(input) {
    const { store, schema } = tableOf(input.TableName);
    const k = keyString(schema, input.Key);
    const existing = store.get(k) ?? null;
    if (input.ConditionExpression && !evaluateCondition(input.ConditionExpression, existing, input.ExpressionAttributeNames, input.ExpressionAttributeValues)) {
      throw new ConditionalCheckFailed();
    }
    // DynamoDB upserts on Update: an absent item becomes one carrying the key.
    const item = existing ? clone(existing) : { ...input.Key };
    applyUpdate(input.UpdateExpression, item, input.ExpressionAttributeNames, input.ExpressionAttributeValues);
    store.set(k, item);
    return input.ReturnValues === "ALL_NEW" ? { Attributes: clone(item) } : {};
  }

  function del(input) {
    const { store, schema } = tableOf(input.TableName);
    guard(input.TableName, input.Key, input.ConditionExpression, input.ExpressionAttributeNames, input.ExpressionAttributeValues);
    store.delete(keyString(schema, input.Key));
    return {};
  }

  function get(input) {
    const { store, schema } = tableOf(input.TableName);
    const item = store.get(keyString(schema, input.Key));
    if (!item) return {};
    return { Item: clone(project(item, input.ProjectionExpression, input.ExpressionAttributeNames)) };
  }

  function query(input) {
    const { store, schema } = tableOf(input.TableName);
    const keys = input.IndexName ? schema.indexes?.[input.IndexName] : schema;
    if (!keys) throw new Error(`unknown index ${input.IndexName} on ${input.TableName}`);

    let rows = [...store.values()];
    // A GSI is SPARSE: a row that does not carry the index's partition key is
    // not in it at all. Several queries here rely on that (only META carries
    // `tenantStatus`), so dropping it would return every item in the table.
    if (input.IndexName) rows = rows.filter((r) => r[keys.pk] !== undefined);

    rows = rows.filter((r) =>
      evaluateCondition(input.KeyConditionExpression, r, { ...input.ExpressionAttributeNames, ...aliasFor(keys) }, input.ExpressionAttributeValues)
    );
    if (input.FilterExpression) {
      rows = rows.filter((r) => evaluateCondition(input.FilterExpression, r, input.ExpressionAttributeNames, input.ExpressionAttributeValues));
    }

    const sortKey = keys.sk;
    if (sortKey) {
      rows.sort((a, b) => {
        const av = a[sortKey];
        const bv = b[sortKey];
        return av === bv ? 0 : av < bv ? -1 : 1;
      });
    }
    if (input.ScanIndexForward === false) rows.reverse();
    if (input.Limit) rows = rows.slice(0, input.Limit);

    const items = rows.map((r) => clone(project(r, input.ProjectionExpression, input.ExpressionAttributeNames)));
    return { Items: items, Count: items.length };
  }

  /**
   * A KeyConditionExpression names the INDEX's key attributes directly (`PK`,
   * `tenantStatus`, …) and those are what the item carries, so no aliasing is
   * needed — this exists only so a caller that aliased a reserved word still
   * resolves. Returns nothing when there is nothing to add.
   */
  function aliasFor() {
    return {};
  }

  function scan(input) {
    const { store } = tableOf(input.TableName);
    let rows = [...store.values()];
    if (input.FilterExpression) {
      rows = rows.filter((r) => evaluateCondition(input.FilterExpression, r, input.ExpressionAttributeNames, input.ExpressionAttributeValues));
    }
    if (input.Limit) rows = rows.slice(0, input.Limit);
    const items = rows.map((r) => clone(project(r, input.ProjectionExpression, input.ExpressionAttributeNames)));
    return { Items: items, Count: items.length };
  }

  function transactWrite(input) {
    // Two passes: check every condition, then apply. A transaction that half
    // applied would make a failed conditional look like a successful write on
    // the items before it, which is the exact behaviour the callers guard on.
    const reasons = input.TransactItems.map((entry) => {
      const op = entry.Put || entry.Update || entry.Delete || entry.ConditionCheck;
      const { store, schema } = tableOf(op.TableName);
      const key = entry.Put ? op.Item : op.Key;
      const existing = store.get(keyString(schema, key)) ?? null;
      if (!op.ConditionExpression) return { Code: "None" };
      const ok = evaluateCondition(op.ConditionExpression, existing, op.ExpressionAttributeNames, op.ExpressionAttributeValues);
      return ok ? { Code: "None" } : { Code: "ConditionalCheckFailed" };
    });
    if (reasons.some((r) => r.Code !== "None")) throw new TransactionCanceled(reasons);

    for (const entry of input.TransactItems) {
      if (entry.Put) put({ ...entry.Put, ConditionExpression: undefined });
      else if (entry.Update) update({ ...entry.Update, ConditionExpression: undefined });
      else if (entry.Delete) del({ ...entry.Delete, ConditionExpression: undefined });
    }
    return {};
  }

  function batchWrite(input) {
    for (const [name, requests] of Object.entries(input.RequestItems || {})) {
      for (const r of requests) {
        if (r.PutRequest) put({ TableName: name, Item: r.PutRequest.Item });
        else if (r.DeleteRequest) del({ TableName: name, Key: r.DeleteRequest.Key });
      }
    }
    return { UnprocessedItems: {} };
  }

  const HANDLERS = {
    GetCommand: get,
    PutCommand: put,
    UpdateCommand: update,
    DeleteCommand: del,
    QueryCommand: query,
    ScanCommand: scan,
    TransactWriteCommand: transactWrite,
    BatchWriteCommand: batchWrite,
  };

  return {
    async send(command) {
      const kind = command?.constructor?.name;
      const handler = HANDLERS[kind];
      // Named rather than ignored: a command this does not implement would
      // otherwise resolve to `undefined` and surface as an unrelated TypeError
      // three frames away in application code.
      if (!handler) throw new Error(`in-memory dynamo: unsupported command ${kind}`);
      return handler(command.input);
    },
    /** Test-only reach-in, for asserting persistence without a route. */
    dump(tableKey) {
      return [...tableOf(tableNames[tableKey]).store.values()].map(clone);
    },
    reset() {
      for (const store of stores.values()) store.clear();
    },
  };
}
