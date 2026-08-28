// Journey report generation (docs 20 §6) and journey context injection
// (docs 20 §12.1) — direct calls, the same "call the function, not the
// HTTP route" style test/agent.mjs already uses for createLlmProvider.
// Offline: `c.llm` is injected, so no secret and no network call is needed.
import assert from "node:assert/strict";
import {
  generateJourneyReport,
  journeyPk,
  resolveJourneyForKelabo,
  queryJourneyTimeline,
  submitJourneyReport,
  postJourneyBoardMessage,
  bumpJourneyContributor,
  settleKelaboJoin,
  resolveJourneyAccess,
  putJourneyMessage,
  queryJourneyMessages,
  editJourneyMessage,
  deleteJourneyMessage,
  pinJourneyMessage,
  resolveJourneyMentions,
  getJourneyReadCursor,
  listJourneyReadCursors,
  advanceJourneyReadCursor,
  listJourneyThreads,
  createJourneyThread,
  ensureDefaultThread,
  renameJourneyThread,
  DEFAULT_THREAD_ID,
} from "../src/journeys.js";
import { loadJourneyContext, historyStillApplies } from "../src/agent/journeyContext.js";
import { mainAgentSystemPrompt } from "../src/agent/persona.js";
import { journeyUnread, cursorsByThread } from "@kelabo/contracts";

function makeStore(seed = {}) {
  const items = new Map(Object.entries(seed));
  const key = (k) => `${k.PK}|${k.SK}`;
  // `if_not_exists(attr, :default) [+ :inc]` — the atomic-counter idiom
  // §12.2's new writes use (bumpJourneyContributor, reportCount,
  // boardMessageCount) — resolved against the item as it stands *before*
  // this update, the same as DynamoDB itself.
  // A plain `.split(", ")` breaks the moment one clause's own argument list
  // has a comma in it — exactly what `if_not_exists(attr, :default)` is —
  // so this only ever splits on a comma outside parentheses.
  const splitClauses = (expr) => {
    const parts = [];
    let depth = 0;
    let last = 0;
    for (let i = 0; i < expr.length; i++) {
      const ch = expr[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (depth === 0 && expr.startsWith(", ", i)) {
        parts.push(expr.slice(last, i));
        i += 1;
        last = i + 1;
      }
    }
    parts.push(expr.slice(last));
    return parts;
  };
  const evalRhs = (rhsRaw, existing, names, values) => {
    const m = rhsRaw.match(/^if_not_exists\((#?\w+),\s*(:\w+)\)(?:\s*\+\s*(:\w+))?$/);
    if (!m) return values[rhsRaw];
    const [, defAttrRaw, defaultVar, incVar] = m;
    const defAttr = defAttrRaw.startsWith("#") ? names?.[defAttrRaw] || defAttrRaw : defAttrRaw;
    const current = existing?.[defAttr] !== undefined ? existing[defAttr] : values[defaultVar];
    return incVar ? current + values[incVar] : current;
  };
  return {
    items,
    send: async (cmd) => {
      const name = cmd.constructor.name;
      if (name === "GetCommand") {
        return { Item: items.get(key(cmd.input.Key)) };
      }
      if (name === "PutCommand") {
        const k = key(cmd.input.Item);
        if (cmd.input.ConditionExpression === "attribute_not_exists(SK)" && items.has(k)) {
          const e = new Error("ConditionalCheckFailedException");
          e.name = "ConditionalCheckFailedException";
          throw e;
        }
        items.set(k, { ...cmd.input.Item });
        return {};
      }
      if (name === "QueryCommand") {
        const pk = cmd.input.ExpressionAttributeValues[":pk"];
        const skPrefix = cmd.input.ExpressionAttributeValues[":sk"];
        const before = cmd.input.ExpressionAttributeValues[":before"];
        // `BETWEEN :lo AND :hi` — inclusive at both ends, exactly as DynamoDB
        // is, which is what makes the channel's cursor-exclusion worth
        // testing rather than assuming (queryJourneyMessages drops the cursor
        // row itself, and would be silently wrong against a fake that
        // excluded it here).
        const lo = cmd.input.ExpressionAttributeValues[":lo"];
        const hi = cmd.input.ExpressionAttributeValues[":hi"];
        let out = lo !== undefined
          ? [...items.values()].filter((i) => i.PK === pk && String(i.SK) >= lo && String(i.SK) <= hi)
          : before
          ? [...items.values()].filter((i) => i.PK === pk && String(i.SK) < before)
          : [...items.values()].filter((i) => i.PK === pk && String(i.SK).startsWith(skPrefix));
        if (cmd.input.FilterExpression === "#type = :type") {
          const typeAttr = cmd.input.ExpressionAttributeNames?.["#type"] || "type";
          const wanted = cmd.input.ExpressionAttributeValues[":type"];
          out = out.filter((i) => i[typeAttr] === wanted);
        }
        out = out.slice().sort((a, b) => (a.SK < b.SK ? -1 : a.SK > b.SK ? 1 : 0));
        if (cmd.input.ScanIndexForward === false) out.reverse();
        if (cmd.input.Limit) out = out.slice(0, cmd.input.Limit);
        return { Items: out };
      }
      if (name === "UpdateCommand") {
        const k = key(cmd.input.Key);
        const existing = items.get(k);
        const cond = cmd.input.ConditionExpression;
        const values = cmd.input.ExpressionAttributeValues;
        const fail = () => {
          const e = new Error("ConditionalCheckFailedException");
          e.name = "ConditionalCheckFailedException";
          throw e;
        };
        if ((cond === "attribute_exists(PK)" || cond === "attribute_exists(SK)") && !existing) fail();
        // The read cursor's monotonic guard (docs 20 §19.3). Written out
        // rather than pattern-matched loosely: the whole point of the clause
        // is that a stale `at` is refused, and a fake that accepted it would
        // make the test that asserts so pass for the wrong reason.
        //
        // The `attribute_not_exists(<attr>)` arm matters as much as the rest.
        // Being mentioned creates a READ# row carrying only a mentionCount, so
        // the row can exist while `lastReadAt` does not — and DynamoDB
        // evaluates `lastReadAt < :at` against a missing attribute as FALSE,
        // not as "unset, so anything is newer". A fake that ignored the arm
        // would let that cursor advance here and never in production.
        const monotonic = cond?.match(
          /^attribute_not_exists\(SK\)(?: OR attribute_not_exists\((\w+)\))? OR (\w+) < (:\w+)$/
        );
        if (monotonic && existing) {
          const [, orAbsent, attr, valueVar] = monotonic;
          const present = existing[attr] !== undefined;
          const passes = (orAbsent && !present) || (present && Number(existing[attr]) < Number(values[valueVar]));
          if (!passes) fail();
        }
        // SET (+ optional trailing REMOVE): plain `:value` substitution, or
        // the atomic-counter shape above.
        const item = { ...existing };
        const [, setExpr = "", removeExpr = ""] =
          cmd.input.UpdateExpression.match(/^SET (.*?)(?:\s+REMOVE\s+(.*))?$/s) || [];
        for (const clause of splitClauses(setExpr)) {
          const eq = clause.indexOf(" = ");
          if (eq < 0) continue;
          const lhs = clause.slice(0, eq).trim();
          const rhs = clause.slice(eq + 3).trim();
          const attr = cmd.input.ExpressionAttributeNames?.[lhs] || lhs;
          item[attr] = evalRhs(rhs, existing, cmd.input.ExpressionAttributeNames, values);
        }
        for (const raw of removeExpr ? splitClauses(removeExpr) : []) {
          const name_ = raw.trim();
          delete item[cmd.input.ExpressionAttributeNames?.[name_] || name_];
        }
        item.PK = cmd.input.Key.PK;
        item.SK = cmd.input.Key.SK;
        items.set(k, item);
        return {};
      }
      throw new Error(`unhandled command ${name}`);
    },
  };
}

function baseSeed(journeyId) {
  return {
    [`${journeyPk(journeyId)}|META`]: { PK: journeyPk(journeyId), SK: "META", journeyId, title: "Q3 Launch", health: "yellow", progress: 40 },
    [`${journeyPk(journeyId)}|REPORT#r1`]: { PK: journeyPk(journeyId), SK: "REPORT#r1", reportId: "r1", question: "Where are we?", requestedBy: "alice@example.com", requestedAt: Date.now(), status: "pending" },
  };
}

// `getCredential` is here because `generateJourneyReport` falls back to the
// `llm` credential slot when a container is assembled by hand — unreachable in
// production, since `createContainer` always supplies `c.llm` (see the
// container tests at the foot of this file), but it is the branch that decides
// `llm_not_configured` and it is cheap to keep honest.
function makeContainer({ store, llm, credential }) {
  return {
    config: { tableNames: { journeys: "j", kelabos: "k" }, secrets: {}, llm: { provider: "fake", model: "m" }, openaiBaseUrl: "" },
    db: store,
    llm,
    getCredential: async () => credential ?? null,
    log: () => {},
    logError: () => {},
  };
}

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

await test("journey not found: fails without ever consulting the LLM", async () => {
  const store = makeStore({});
  let called = false;
  const c = makeContainer({ store, llm: { completeRaw: async () => { called = true; return { text: "x" }; } } });
  const result = await generateJourneyReport(c, "nope", { reportId: "r1", question: "q" });
  assert.equal(result.body.status, "failed");
  assert.equal(result.body.error, "journey_not_found");
  assert.equal(called, false);
});

await test("success: assembles description + linked kelabo minutes + board into the prompt, persists the answer", async () => {
  const journeyId = "j1";
  const seed = baseSeed(journeyId);
  seed[`${journeyPk(journeyId)}|DESC#000001`] = { PK: journeyPk(journeyId), SK: "DESC#000001", version: 1, markdown: "This project ships the Q3 redesign." };
  seed[`${journeyPk(journeyId)}|LINK#k1`] = { PK: journeyPk(journeyId), SK: "LINK#k1", kelaboId: "k1", titleSnapshot: "Kickoff", linkedAt: 1 };
  seed[`${journeyPk(journeyId)}|BOARDMSG#m1`] = { PK: journeyPk(journeyId), SK: "BOARDMSG#m1", msgId: "m1", content: "Ship date is fixed", archived: false, createdAt: 1 };
  // An archived message must never reach the prompt.
  seed[`${journeyPk(journeyId)}|BOARDMSG#m2`] = { PK: journeyPk(journeyId), SK: "BOARDMSG#m2", msgId: "m2", content: "SECRET stale note", archived: true, createdAt: 2 };
  seed["KELABO#k1|MINUTES"] = { PK: "KELABO#k1", SK: "MINUTES", kelaboId: "k1", summary: "Decided to use React.", decisions: ["Use React"], actionItems: [] };
  const store = makeStore(seed);

  let promptSeen = null;
  const llm = { completeRaw: async (req) => { promptSeen = req.messages[0].content; return { text: "The project ships in Q3, using React per the kickoff decision.", usage: { inputTokens: 900, outputTokens: 120 } }; } };
  const c = makeContainer({ store, llm });

  const result = await generateJourneyReport(c, journeyId, { reportId: "r1", question: "What did we decide about the framework?" });
  assert.equal(result.body.status, "ready");
  assert.ok(result.body.answer.includes("React"));

  assert.ok(promptSeen.includes("This project ships the Q3 redesign"), "description reached the prompt");
  assert.ok(promptSeen.includes("Ship date is fixed"), "active board message reached the prompt");
  assert.equal(promptSeen.includes("SECRET stale note"), false, "an archived board message must not reach the prompt");
  assert.ok(promptSeen.includes("Decided to use React"), "the linked kelabo's minutes reached the prompt");
  assert.ok(promptSeen.includes("health=yellow"), "health/progress reached the prompt");

  const persisted = store.items.get(`${journeyPk(journeyId)}|REPORT#r1`);
  assert.equal(persisted.status, "ready");
  assert.equal(persisted.answer, result.body.answer);
  assert.ok(typeof persisted.generatedAt === "number");
});

await test("a private report never becomes context for someone else's report (docs 20 §6.4)", async () => {
  const journeyId = "j-priv";
  const seed = baseSeed(journeyId);
  seed[`${journeyPk(journeyId)}|REPORT#rpub`] = {
    PK: journeyPk(journeyId), SK: "REPORT#rpub", reportId: "rpub", question: "Public question?",
    answer: "PUBLIC PRIOR ANSWER", status: "ready", requestedBy: "alice@example.com", requestedAt: 2, visibility: "public",
  };
  seed[`${journeyPk(journeyId)}|REPORT#rpriv`] = {
    PK: journeyPk(journeyId), SK: "REPORT#rpriv", reportId: "rpriv", question: "Is Bob behind?",
    answer: "PRIVATE PRIOR ANSWER", status: "ready", requestedBy: "bob@example.com", requestedAt: 3, visibility: "private",
  };
  const store = makeStore(seed);
  let promptSeen = null;
  const llm = { completeRaw: async (req) => { promptSeen = req.messages[0].content; return { text: "ok" }; } };
  const c = makeContainer({ store, llm });

  await generateJourneyReport(c, journeyId, { reportId: "r1", question: "How is it going?" });
  assert.ok(promptSeen.includes("PUBLIC PRIOR ANSWER"), "a public prior report is context, as before");
  // The whole point: this answer is readable by whoever asks next, so a
  // private report reaching it would launder one member's private question
  // into a shared answer.
  assert.equal(promptSeen.includes("PRIVATE PRIOR ANSWER"), false, "a private prior report must not reach the prompt");
  assert.equal(promptSeen.includes("Is Bob behind?"), false, "nor its question");
});

await test("the metering seam: refused before the spend, reported after it, and absent by default (docs 20 §6.5)", async () => {
  const journeyId = "j-meter";
  // Absent by default — the self-hosting case, where there is no `c.usage`
  // at all. This is the assertion that keeps the seam optional.
  {
    const store = makeStore(baseSeed(journeyId));
    const c = makeContainer({ store, llm: { completeRaw: async () => ({ text: "ok", usage: { inputTokens: 5 } }) } });
    const out = await generateJourneyReport(c, journeyId, { reportId: "r1", question: "q" });
    assert.equal(out.body.status, "ready");
  }

  // Reported after the spend, with the provider's own usage record and the
  // identity that asked — never a locally counted approximation.
  {
    const store = makeStore(baseSeed(journeyId));
    const notes = [];
    const c = makeContainer({ store, llm: { completeRaw: async () => ({ text: "ok", usage: { inputTokens: 900, outputTokens: 120 } }) } });
    c.usage = { noteJourneyReport: async (jid, info) => notes.push({ jid, ...info }) };
    await generateJourneyReport(c, journeyId, { reportId: "r1", question: "q", identity: "asker@example.com" });
    assert.equal(notes.length, 1);
    assert.equal(notes[0].jid, journeyId);
    assert.equal(notes[0].identity, "asker@example.com");
    assert.deepEqual(notes[0].usage, { inputTokens: 900, outputTokens: 120 });
  }

  // A meter that throws must not turn a generated answer into a failed
  // report: the spend already happened, and the reader is owed the answer.
  {
    const store = makeStore(baseSeed(journeyId));
    const c = makeContainer({ store, llm: { completeRaw: async () => ({ text: "ok" }) } });
    c.usage = { noteJourneyReport: async () => { throw new Error("meter down"); } };
    const out = await generateJourneyReport(c, journeyId, { reportId: "r1", question: "q" });
    assert.equal(out.body.status, "ready");
  }

  // Refused before the spend: no provider call at all, and the report is
  // marked failed with the refusal's own reason.
  {
    const store = makeStore(baseSeed(journeyId));
    let called = false;
    const c = makeContainer({ store, llm: { completeRaw: async () => { called = true; return { text: "ok" }; } } });
    c.usage = { allowJourneyReport: async () => ({ ok: false, reason: "journey_suspended" }) };
    const out = await generateJourneyReport(c, journeyId, { reportId: "r1", question: "q" });
    assert.equal(called, false, "a refusal must come before the spend, not after");
    assert.equal(out.body.status, "failed");
    assert.equal(out.body.error, "journey_suspended");
    assert.equal(store.items.get(`${journeyPk(journeyId)}|REPORT#r1`).status, "failed");
  }
});

await test("llm failure: the report row is marked failed with a reason, not left pending", async () => {
  const journeyId = "j2";
  const store = makeStore(baseSeed(journeyId));
  const llm = { completeRaw: async () => { throw new Error("provider unreachable"); } };
  const c = makeContainer({ store, llm });
  const result = await generateJourneyReport(c, journeyId, { reportId: "r1", question: "q" });
  assert.equal(result.body.status, "failed");
  assert.equal(result.body.error, "llm_failed");
  assert.equal(store.items.get(`${journeyPk(journeyId)}|REPORT#r1`).status, "failed");
});

await test("no LLM configured: fails cleanly instead of throwing", async () => {
  const journeyId = "j3";
  const store = makeStore(baseSeed(journeyId));
  const c = makeContainer({ store, llm: undefined, credential: null });
  const result = await generateJourneyReport(c, journeyId, { reportId: "r1", question: "q" });
  assert.equal(result.body.status, "failed");
  assert.equal(result.body.error, "llm_not_configured");
});

// --- journey context injection (docs 20 §12.1, the PUSH half) ---------------

await test("loadJourneyContext: a kelabo with no journey link costs one empty query and returns nothing", async () => {
  const store = makeStore({});
  const c = makeContainer({ store });
  const journeys = await loadJourneyContext(c, "k-lonely");
  assert.deepEqual(journeys, []);
});

await test("loadJourneyContext: reduces the journey to title/description/status/board/documents/other-kelabos, excludes itself and a kelabo with no minutes", async () => {
  const journeyId = "j-ctx";
  const liveKelaboId = "k-live";
  const otherKelaboId = "k-other";
  const emptyKelaboId = "k-empty";
  const longDoc = "x".repeat(1000);
  const seed = {
    // The mirror on the live kelabo's own partition (docs 20 §4.3) — what
    // makes this kelabo discoverable as belonging to the journey at all.
    [`KELABO#${liveKelaboId}|JOURNEY#${journeyId}`]: { PK: `KELABO#${liveKelaboId}`, SK: `JOURNEY#${journeyId}`, journeyId },
    [`${journeyPk(journeyId)}|META`]: { PK: journeyPk(journeyId), SK: "META", title: "Q3 Launch", health: "green", progress: 80 },
    [`${journeyPk(journeyId)}|DESC#000001`]: { PK: journeyPk(journeyId), SK: "DESC#000001", version: 1, markdown: "Ship the redesign." },
    [`${journeyPk(journeyId)}|BOARDMSG#m1`]: { PK: journeyPk(journeyId), SK: "BOARDMSG#m1", msgId: "m1", content: "Freeze is Friday", archived: false, createdAt: 1 },
    // A live production bug report (a term defined only in a document went
    // unseen by the assistant, which dispatched external research instead
    // of just reading it here) is what this document coverage guards
    // against regressing. One active, one removed (must never reach the
    // context, same as an archived board message), one long enough to
    // prove per-document clipping actually applies.
    [`${journeyPk(journeyId)}|DOC#d1`]: { PK: journeyPk(journeyId), SK: "DOC#d1", docId: "d1", title: "FluxView glossary", content: "FluxView is the internal dashboard for release health.", removed: false, addedAt: 2 },
    [`${journeyPk(journeyId)}|DOC#d2`]: { PK: journeyPk(journeyId), SK: "DOC#d2", docId: "d2", title: "Old notes", content: "SECRET stale content", removed: true, addedAt: 1 },
    [`${journeyPk(journeyId)}|DOC#d3`]: { PK: journeyPk(journeyId), SK: "DOC#d3", docId: "d3", title: "Long spec", content: longDoc, removed: false, addedAt: 3 },
    // The journey also links the live kelabo itself, and one other kelabo
    // with minutes, and one with none at all.
    [`${journeyPk(journeyId)}|LINK#${liveKelaboId}`]: { PK: journeyPk(journeyId), SK: `LINK#${liveKelaboId}`, kelaboId: liveKelaboId, titleSnapshot: "This very kelabo", linkedAt: 1 },
    [`${journeyPk(journeyId)}|LINK#${otherKelaboId}`]: { PK: journeyPk(journeyId), SK: `LINK#${otherKelaboId}`, kelaboId: otherKelaboId, titleSnapshot: "Kickoff", linkedAt: 2 },
    [`${journeyPk(journeyId)}|LINK#${emptyKelaboId}`]: { PK: journeyPk(journeyId), SK: `LINK#${emptyKelaboId}`, kelaboId: emptyKelaboId, titleSnapshot: "Not summarised yet", linkedAt: 3 },
    "KELABO#k-other|MINUTES": { PK: "KELABO#k-other", SK: "MINUTES", summary: "Agreed on React.", decisions: ["Use React"], actionItems: [] },
    // k-empty has no MINUTES item at all.
  };
  const store = makeStore(seed);
  const c = makeContainer({ store });

  const journeys = await loadJourneyContext(c, liveKelaboId);
  assert.equal(journeys.length, 1);
  const j = journeys[0];
  assert.equal(j.title, "Q3 Launch");
  assert.equal(j.description, "Ship the redesign.");
  assert.equal(j.health, "green");
  assert.equal(j.progress, 80);
  assert.deepEqual(j.board, ["Freeze is Friday"]);
  assert.equal(j.documents.length, 2, "removed document excluded, two active ones kept");
  assert.ok(j.documents.some((d) => d.title === "FluxView glossary" && d.content.includes("release health")), "the exact gap this closes: a term defined only in a document reaches the assistant");
  assert.equal(j.documents.some((d) => d.content.includes("SECRET stale content")), false, "a removed document must never reach the prompt");
  const long = j.documents.find((d) => d.title === "Long spec");
  assert.equal(long.content.length, 801, "clipped to 800 chars plus the ellipsis marker");
  assert.ok(long.content.endsWith("…"));
  assert.equal(j.kelabos.length, 1, "only the other, summarised kelabo — never itself, never the empty one");
  assert.equal(j.kelabos[0].title, "Kickoff");
  assert.ok(j.kelabos[0].summary.includes("React"));
});

await test("historyStillApplies: a journey link supersedes historyEnabled rather than stacking with it", () => {
  // Off in the first place: nothing to supersede.
  assert.equal(historyStillApplies({ historyEnabled: false }, []), false);
  assert.equal(historyStillApplies(undefined, []), false, "no META at all reads the same as off");
  // On, and no journey in the way: applies exactly as it always has.
  assert.equal(historyStillApplies({ historyEnabled: true }, []), true);
  // On, but a journey link exists: superseded, even though historyEnabled
  // itself was never turned off.
  assert.equal(historyStillApplies({ historyEnabled: true }, [{ title: "Q3 Launch" }]), false);
  // A dangling/unreachable link that loadJourneyContext could not actually
  // resolve into anything reduces to an empty array — the same as no link
  // at all — so historyEnabled falls back on, rather than the kelabo
  // getting neither source (docs 20 §12.1's "best-effort, never total
  // silence" posture).
  assert.equal(historyStillApplies({ historyEnabled: true }, []), true);
});

await test("mainAgentSystemPrompt: journeys render a JOURNEY CONTEXT section, additive to (not replacing) EARLIER KELABOS", async () => {
  const withNeither = mainAgentSystemPrompt({});
  assert.equal(withNeither.includes("JOURNEY CONTEXT"), false);

  const withBoth = mainAgentSystemPrompt({
    history: [{ title: "Old kelabo", endedAt: Date.now(), summary: "Discussed pricing.", decisions: [], actionItems: [] }],
    journeys: [{
      title: "Q3 Launch", description: "Ship the redesign.", health: "yellow", progress: 40,
      board: ["Freeze is Friday"],
      documents: [{ title: "FluxView glossary", content: "FluxView is the internal dashboard for release health." }],
      kelabos: [],
    }],
  });
  assert.ok(withBoth.includes("EARLIER KELABOS"));
  assert.ok(withBoth.includes("Old kelabo"));
  assert.ok(withBoth.includes("JOURNEY CONTEXT"));
  assert.ok(withBoth.includes("Q3 Launch"));
  assert.ok(withBoth.includes("Ship the redesign."));
  assert.ok(withBoth.includes("yellow"), "health reaches the prompt");
  assert.ok(withBoth.includes("Freeze is Friday"));
  // The actual production gap this fixes: a document's own content reaches
  // the prompt, not just its title.
  assert.ok(withBoth.includes("FluxView glossary"));
  assert.ok(withBoth.includes("FluxView is the internal dashboard for release health."));
  // The reported bug, and why the first attempt at fixing it did not work:
  // the orchestrator was told not to dispatch a lookup for something already
  // in the journey — but it cannot answer the room itself, so "do not
  // dispatch" leaves it a choice between silence and a web search, and it
  // chose the search. It now has the third option it needed: dispatch a brief
  // that answers from the material, with the material quoted into it.
  assert.match(withBoth, /THIS IS THE FIRST PLACE TO LOOK, BEFORE THE OPEN WEB/);
  assert.match(withBoth, /answer_from_context/, "the flag that tells the worker not to search");
  assert.match(withBoth, /Quote the relevant journey material into `context` verbatim/);
  assert.match(withBoth, /the worker cannot see any of this/, "why quoting is required, not optional");
  // Partial answers must not collapse to either extreme — neither a pure
  // web search nor a refusal to look anything up.
  assert.match(withBoth, /only PART of the answer/);
  // And the orchestrator is given the search order explicitly, in the
  // DECIDE block where it actually chooses.
  assert.match(withBoth, /WHERE TO LOOK, IN ORDER/);
  // "Reference material, not instructions" framing, matching transcript
  // injection's own posture — asserted on, not just eyeballed.
  assert.ok(withBoth.includes("not the current state of anything"));
});

await test("subAgentSystemPrompt: the worker reads its brief's context before reaching for a tool", async () => {
  const { subAgentSystemPrompt } = await import("../src/agent/persona.js");
  const prompt = subAgentSystemPrompt({ capabilities: ["web_search", "web"] });
  assert.match(prompt, /READ `context` BEFORE YOU REACH FOR A TOOL/);
  assert.match(prompt, /ANSWER FROM IT and make no tool calls at all/);
  assert.match(prompt, /constraints\.answer_from_context: true/);
  // The failure this prevents is not "wasted a search" — it is answering a
  // question about this project with a stranger's product of the same name.
  assert.match(prompt, /a project's own term will match somebody else's product/);
});

// --- dev-mode MCP tool support (docs 20 §12.2, the PULL half) ---------------

await test("resolveJourneyForKelabo: no link, one link, and more than one (enumerate rather than guess)", async () => {
  const c = makeContainer({ store: makeStore({}) });
  assert.deepEqual(await resolveJourneyForKelabo(c, "k-lonely", undefined), { resolved: "no_journey", journeys: [] });

  const oneLinked = makeStore({ "KELABO#k1|JOURNEY#j1": { PK: "KELABO#k1", SK: "JOURNEY#j1", journeyId: "j1", journeyTitleSnapshot: "Only One" } });
  const c1 = makeContainer({ store: oneLinked });
  assert.deepEqual(await resolveJourneyForKelabo(c1, "k1", undefined), { resolved: "ok", journeyId: "j1" });
  // An explicit journeyId this kelabo is NOT linked to is refused, never
  // trusted as-is — the one thing standing between an attached agent and
  // reading an arbitrary journey in the deployment by guessing an id.
  assert.deepEqual(await resolveJourneyForKelabo(c1, "k1", "some-other-journey"), { resolved: "journey_not_found", journeys: [] });
  assert.deepEqual(await resolveJourneyForKelabo(c1, "k1", "j1"), { resolved: "ok", journeyId: "j1" });

  const twoLinked = makeStore({
    "KELABO#k2|JOURNEY#j1": { PK: "KELABO#k2", SK: "JOURNEY#j1", journeyId: "j1", journeyTitleSnapshot: "First" },
    "KELABO#k2|JOURNEY#j2": { PK: "KELABO#k2", SK: "JOURNEY#j2", journeyId: "j2", journeyTitleSnapshot: "Second" },
  });
  const c2 = makeContainer({ store: twoLinked });
  const ambiguous = await resolveJourneyForKelabo(c2, "k2", undefined);
  assert.equal(ambiguous.resolved, "ambiguous");
  assert.equal(ambiguous.journeys.length, 2);
  assert.ok(ambiguous.journeys.some((j) => j.journeyId === "j1" && j.title === "First"));
  // Naming one resolves it even though the kelabo has more than one link.
  assert.deepEqual(await resolveJourneyForKelabo(c2, "k2", "j2"), { resolved: "ok", journeyId: "j2" });
});

await test("queryJourneyTimeline: newest first, a type filter, and a before cursor that excludes its own row", async () => {
  const journeyId = "j-tl";
  const seed = {};
  const rows = [
    { at: 1000, type: "description", summary: "Description updated" },
    { at: 2000, type: "report", summary: "Report requested: Q" },
    { at: 3000, type: "board_message", summary: "Board message added" },
  ];
  for (const r of rows) {
    seed[`${journeyPk(journeyId)}|TL#${String(r.at).padStart(13, "0")}#abc`] = {
      PK: journeyPk(journeyId), SK: `TL#${String(r.at).padStart(13, "0")}#abc`, ...r,
    };
  }
  const c = makeContainer({ store: makeStore(seed) });

  const all = await queryJourneyTimeline(c, journeyId, {});
  assert.deepEqual(all.map((e) => e.at), [3000, 2000, 1000], "newest first");

  const onlyReports = await queryJourneyTimeline(c, journeyId, { type: "report" });
  assert.equal(onlyReports.length, 1);
  assert.equal(onlyReports[0].summary, "Report requested: Q");

  const page = await queryJourneyTimeline(c, journeyId, { before: 3000 });
  assert.deepEqual(page.map((e) => e.at), [2000, 1000], "before excludes the row at that timestamp, not just after it");
});

await test("submitJourneyReport: stores a ready report with no LLM, bumps reportCount and reportRequestCount, records a timeline row", async () => {
  const journeyId = "j-submit";
  const seed = { [`${journeyPk(journeyId)}|META`]: { PK: journeyPk(journeyId), SK: "META", journeyId, reportCount: 2 } };
  const store = makeStore(seed);
  const c = makeContainer({ store });

  const { reportId } = await submitJourneyReport(c, journeyId, { reportId: "r-new", question: "What shipped?", answer: "The redesign shipped.", identity: "alice@example.com" });
  assert.equal(reportId, "r-new");

  const report = store.items.get(`${journeyPk(journeyId)}|REPORT#r-new`);
  assert.equal(report.status, "ready");
  assert.equal(report.answer, "The redesign shipped.");
  assert.equal(report.generatedBy, "agent", "distinguishable from an LLM-generated one");
  assert.equal(report.requestedBy, "alice@example.com");

  const meta = store.items.get(`${journeyPk(journeyId)}|META`);
  assert.equal(meta.reportCount, 3, "existing count incremented, not reset");

  const contributor = store.items.get(`${journeyPk(journeyId)}|CONTRIBUTOR#alice@example.com`);
  assert.equal(contributor.reportRequestCount, 1, "counts the act of asking the same as a REST-requested report");

  const timelineRows = [...store.items.values()].filter((i) => String(i.SK).startsWith("TL#"));
  assert.equal(timelineRows.length, 1);
  assert.equal(timelineRows[0].type, "report");
  assert.equal(timelineRows[0].actor, "alice@example.com");
});

await test("postJourneyBoardMessage: creates, versions an edit, and refuses a missing or archived message", async () => {
  const journeyId = "j-post";
  const store = makeStore({ [`${journeyPk(journeyId)}|META`]: { PK: journeyPk(journeyId), SK: "META", journeyId } });
  const c = makeContainer({ store });

  const created = await postJourneyBoardMessage(c, journeyId, { content: "Freeze is Friday", identity: "bob@example.com" });
  assert.equal(created.ok, true);
  assert.equal(created.version, 1);
  const head = store.items.get(`${journeyPk(journeyId)}|BOARDMSG#${created.msgId}`);
  assert.equal(head.content, "Freeze is Friday");
  assert.equal(head.createdBy, "bob@example.com");
  assert.equal(store.items.get(`${journeyPk(journeyId)}|META`).boardMessageCount, 1);
  assert.ok(store.items.get(`${journeyPk(journeyId)}|BOARDMSG#${created.msgId}#V#000001`), "immutable version 1 chain entry");

  const edited = await postJourneyBoardMessage(c, journeyId, { content: "Freeze moved to Monday", msgId: created.msgId, identity: "carol@example.com" });
  assert.equal(edited.ok, true);
  assert.equal(edited.version, 2);
  assert.equal(store.items.get(`${journeyPk(journeyId)}|BOARDMSG#${created.msgId}`).content, "Freeze moved to Monday");
  assert.ok(store.items.get(`${journeyPk(journeyId)}|BOARDMSG#${created.msgId}#V#000002`), "the version-1 entry is never overwritten");
  assert.ok(store.items.get(`${journeyPk(journeyId)}|BOARDMSG#${created.msgId}#V#000001`), "version 1 stays readable behind the edit");

  const missing = await postJourneyBoardMessage(c, journeyId, { content: "x", msgId: "no-such-message", identity: "bob@example.com" });
  assert.deepEqual(missing, { ok: false, reason: "not_found" });

  await postJourneyBoardMessage(c, journeyId, { content: "x", msgId: created.msgId, identity: "bob@example.com" }); // v3
  store.items.get(`${journeyPk(journeyId)}|BOARDMSG#${created.msgId}`).archived = true;
  const onArchived = await postJourneyBoardMessage(c, journeyId, { content: "y", msgId: created.msgId, identity: "bob@example.com" });
  assert.deepEqual(onArchived, { ok: false, reason: "already_archived" }, "the agent bridge can create or edit, never archive or unarchive — that stays a human action, matching §8.2's rule for documents that nothing about a frozen one can be edited");
});

await test("settleKelaboJoin: bumps kelaboJoinCount once per participant, and is a no-op if called again for the same kelabo", async () => {
  const journeyId = "j-settle";
  const store = makeStore({ [`${journeyPk(journeyId)}|META`]: { PK: journeyPk(journeyId), SK: "META", journeyId } });
  const c = makeContainer({ store });

  await settleKelaboJoin(c, journeyId, "k-ended", ["alice@example.com", "bob@example.com"]);
  assert.equal(store.items.get(`${journeyPk(journeyId)}|CONTRIBUTOR#alice@example.com`).kelaboJoinCount, 1);
  assert.equal(store.items.get(`${journeyPk(journeyId)}|CONTRIBUTOR#bob@example.com`).kelaboJoinCount, 1);
  assert.ok(store.items.get(`${journeyPk(journeyId)}|SETTLED#k-ended`), "idempotency marker written");

  // Simulates endKelabo re-running this hook on a retried end for the same
  // kelabo (docs 20 §10's own note that this must not double-count).
  await settleKelaboJoin(c, journeyId, "k-ended", ["alice@example.com", "bob@example.com"]);
  assert.equal(store.items.get(`${journeyPk(journeyId)}|CONTRIBUTOR#alice@example.com`).kelaboJoinCount, 1, "not bumped twice");

  // A second, DIFFERENT kelabo ending settles independently.
  await settleKelaboJoin(c, journeyId, "k-other-ended", ["alice@example.com"]);
  assert.equal(store.items.get(`${journeyPk(journeyId)}|CONTRIBUTOR#alice@example.com`).kelaboJoinCount, 2);
});

await test("bumpJourneyContributor: unconditional ADD idiom, same as rest-api's own", async () => {
  const journeyId = "j-bump";
  const store = makeStore({});
  const c = makeContainer({ store });
  await bumpJourneyContributor(c, journeyId, "dana@example.com", "kelaboJoinCount");
  await bumpJourneyContributor(c, journeyId, "dana@example.com", "kelaboJoinCount");
  await bumpJourneyContributor(c, journeyId, "dana@example.com", "reportRequestCount");
  const row = store.items.get(`${journeyPk(journeyId)}|CONTRIBUTOR#dana@example.com`);
  assert.equal(row.kelaboJoinCount, 2);
  assert.equal(row.reportRequestCount, 1);
  assert.equal(row.contributorIdentity, "dana@example.com");
});

// --- the container's LLM, which is how a question gets answered at all -------
//
// Supplier credentials are rows in the credentials table, not Secrets Manager
// entries, so `config.secrets.llm` no longer exists. `generateJourneyReport`
// falls back to `c.llm` when nothing is injected, and this is the only test of
// the one path that resolves an LLM key outside the agent worker — without it,
// every journey question could fail with `llm_not_configured` while kelabos ran
// perfectly, and nothing would say so.

await test("the container supplies an LLM for journey questions, from the credentials table", async () => {
  const { createContainer } = await import("../src/container.js");
  const credentials = new Map([["llm", { apiKey: "sk-from-the-table" }]]);
  const db = {
    send: async (cmd) => {
      // The credentials read: PK is `CRED#<slot>`.
      const pk = String(cmd.input?.Key?.PK ?? "");
      if (pk.startsWith("CRED#")) {
        const slot = pk.slice("CRED#".length);
        const value = credentials.get(slot);
        return { Item: value ? { value: JSON.stringify(value) } : undefined };
      }
      return {};
    },
  };
  const c = await createContainer({
    config: {
      region: "us-east-1",
      // Exactly what the task carries now: no `secrets.llm` at all.
      secrets: { cookieSigningKey: "k" },
      llm: { provider: "openai", model: "gpt-x", smallModel: "gpt-x" },
      openaiBaseUrl: "https://api.openai.com/v1",
      tableNames: { credentials: "cred", kelabos: "k", journeys: "j" },
    },
    db,
    s3: {},
    secrets: {},
    skipRebuild: true,
  });

  assert.ok(c.llm, "a container must be able to answer a journey question");
  assert.equal(typeof c.llm.completeRaw, "function", "and `completeRaw`, since that is what the report path calls");

  // An empty slot fails loudly rather than posting an empty key.
  credentials.delete("llm");
  await assert.rejects(() => c.llm.completeRaw({ messages: [] }), /llm_not_configured/);
});

await test("KELABO_LLM_API_KEY is a bootstrap for an empty credentials table, and a stored row beats it", async () => {
  // The self-host path: this repository ships no console that writes the
  // credentials table, so without the fallback a fresh deployment has no way
  // to give the gateway a key at all — and a null credential is
  // indistinguishable from a capability deliberately left unconfigured.
  const { createContainer } = await import("../src/container.js");
  const credentials = new Map();
  const db = {
    send: async (cmd) => {
      const pk = String(cmd.input?.Key?.PK ?? "");
      if (pk.startsWith("CRED#")) {
        const value = credentials.get(pk.slice("CRED#".length));
        return { Item: value ? { value: JSON.stringify(value) } : undefined };
      }
      return {};
    },
  };
  const make = () =>
    createContainer({
      config: {
        region: "us-east-1",
        secrets: { cookieSigningKey: "k" },
        llm: { provider: "openai", model: "gpt-x", smallModel: "gpt-x" },
        openaiBaseUrl: "https://api.openai.com/v1",
        bootstrapLlmApiKey: "sk-from-the-env",
        tableNames: { credentials: "cred", kelabos: "k", journeys: "j" },
      },
      db,
      s3: {},
      secrets: {},
      skipRebuild: true,
    });

  const empty = await make();
  assert.deepEqual(await empty.getCredential("llm"), { apiKey: "sk-from-the-env" });
  // Only the slot it bootstraps: an env var must not conjure a credential for
  // a capability nobody configured.
  assert.equal(await empty.getCredential("rtc"), null);

  // A stored row always wins, so an operator who fills the slot later is not
  // silently overridden by an environment variable set months earlier.
  credentials.set("llm", { apiKey: "sk-from-the-table" });
  const filled = await make();
  assert.deepEqual(await filled.getCredential("llm"), { apiKey: "sk-from-the-table" });
});

// --- the journey channel (docs 20 §19) --------------------------------------
//
// The chat that outlives any one kelabo. What is worth testing here is the
// handful of decisions that are invisible until they are wrong: the access
// rule the tunnel and the HTTP handlers now share, the two paging cursors,
// and the counter/cursor arithmetic the unread badge is differenced from.

// Every channel test runs inside one thread; the thread-scoped key shapes are
// asserted where they matter, not restated in forty call sites.
const T = DEFAULT_THREAD_ID;

const channelSeed = (journeyId, meta = {}) => ({
  [`${journeyPk(journeyId)}|META`]: {
    PK: journeyPk(journeyId),
    SK: "META",
    journeyId,
    title: "Q3 Launch",
    tenantId: "example.com",
    ownerIdentity: "alice@example.com",
    visibility: "private",
    status: "active",
    ...meta,
  },
  [`${journeyPk(journeyId)}|THREAD#${T}`]: {
    PK: journeyPk(journeyId),
    SK: `THREAD#${T}`,
    threadId: T,
    title: "General",
    createdAt: 1,
    messageCount: 0,
    lastMessageAt: 0,
    archived: false,
  },
});

await test("resolveJourneyAccess: owner, public-by-tenant, private-by-roster, and no cross-tenant read", async () => {
  const journeyId = "j-access";
  const seed = channelSeed(journeyId);
  seed[`${journeyPk(journeyId)}|ACCESSOR#bob@example.com`] = {
    PK: journeyPk(journeyId),
    SK: "ACCESSOR#bob@example.com",
    identity: "bob@example.com",
  };
  const c = makeContainer({ store: makeStore(seed) });
  const meta = seed[`${journeyPk(journeyId)}|META`];
  const role = (identity, tenant = "example.com") => resolveJourneyAccess(c, meta, { identity, tenant });

  assert.equal(await role("alice@example.com"), "owner");
  assert.equal(await role("bob@example.com"), "member", "on the roster");
  assert.equal(await role("carol@example.com"), "none", "private, not on the roster");
  // The tenant fence comes before everything, so even the owner's own address
  // presented under another tenant is refused.
  assert.equal(await role("alice@example.com", "other.com"), "none");
  assert.equal(await resolveJourneyAccess(c, null, { identity: "alice@example.com" }), "none");
  assert.equal(await resolveJourneyAccess(c, meta, {}), "none", "no identity, no access");

  // Public is tenant-wide — and deliberately does not consult the roster, so
  // a stale ACCESSOR# row left by a private->public flip stays inert.
  const publicMeta = { ...meta, visibility: "public" };
  assert.equal(await resolveJourneyAccess(c, publicMeta, { identity: "carol@example.com", tenant: "example.com" }), "member");
  assert.equal(await resolveJourneyAccess(c, publicMeta, { identity: "dave@other.com", tenant: "other.com" }), "none");
});

await test("putJourneyMessage: append-only, sortable ids, and counters that only grow", async () => {
  const journeyId = "j-post";
  const store = makeStore(channelSeed(journeyId));
  const c = makeContainer({ store });

  const first = await putJourneyMessage(c, journeyId, T, { text: "morning", author: "alice@example.com" });
  const second = await putJourneyMessage(c, journeyId, T, { text: "any news?", author: "bob@example.com" });

  // The id IS the sort suffix, so lexical order is chronological order — the
  // property every cursor in this file depends on.
  assert.ok(first.msgId < second.msgId, "ids sort chronologically");
  assert.match(first.msgId, /^\d{13}-\w{6}$/);
  assert.ok(!first.msgId.includes("#"), "ids travel in a URL path");
  assert.equal(first.kind, "message");

  const meta = store.items.get(`${journeyPk(journeyId)}|META`);
  assert.equal(meta.messageCount, 2);
  assert.equal(meta.lastMessageAt, second.at);
  // `updatedAt` is the journey list's sort key. Chat must not touch it, or
  // every message reorders everybody's journey list.
  assert.equal(meta.updatedAt, undefined, "chat does not reorder the journey list");
});

await test("queryJourneyMessages: `before` walks back, `since` walks forward, and neither repeats its own cursor", async () => {
  const journeyId = "j-page";
  const store = makeStore(channelSeed(journeyId));
  const c = makeContainer({ store });

  const sent = [];
  for (const text of ["one", "two", "three", "four", "five"]) {
    sent.push(await putJourneyMessage(c, journeyId, T, { text, author: "alice@example.com" }));
  }

  // No cursor: the newest page, but always returned oldest-first so the
  // client appends in display order whichever direction it read.
  const newest = await queryJourneyMessages(c, journeyId, T, { limit: 2 });
  assert.deepEqual(newest.messages.map((m) => m.text), ["four", "five"]);
  assert.equal(newest.hasMore, true);
  assert.equal(newest.nextBefore, sent[3].msgId);

  const earlier = await queryJourneyMessages(c, journeyId, T, { before: newest.nextBefore, limit: 2 });
  assert.deepEqual(earlier.messages.map((m) => m.text), ["two", "three"]);
  assert.ok(!earlier.messages.some((m) => m.msgId === newest.nextBefore), "the cursor row is not served twice");

  // `since` is the reconnect shape: everything newer, oldest-first, and it
  // takes the OLDEST unseen ones so a client can never end up with a hole in
  // the middle of its history.
  const missed = await queryJourneyMessages(c, journeyId, T, { since: sent[1].msgId, limit: 2 });
  assert.deepEqual(missed.messages.map((m) => m.text), ["three", "four"]);
  assert.ok(!missed.messages.some((m) => m.msgId === sent[1].msgId), "the cursor row is not served twice");

  const caughtUp = await queryJourneyMessages(c, journeyId, T, { since: sent[4].msgId });
  assert.deepEqual(caughtUp.messages, [], "nothing newer than the newest");
});

await test("queryJourneyMessages: the range stays inside MSG#, never walking into neighbouring rows", async () => {
  const journeyId = "j-fence";
  // Rows that sort either side of the MSG# prefix. An unbounded range walks
  // straight into them — the failure the timeline's own cursor already had,
  // where the agent received blank entries built from LINK#/META rows.
  const seed = channelSeed(journeyId);
  seed[`${journeyPk(journeyId)}|LINK#k1`] = { PK: journeyPk(journeyId), SK: "LINK#k1", kelaboId: "k1" };
  seed[`${journeyPk(journeyId)}|REPORT#r1`] = { PK: journeyPk(journeyId), SK: "REPORT#r1", reportId: "r1" };

  // A sibling thread whose id has this one's as a PREFIX. This is the hazard
  // threads added: `MSG#general2#…` sorts above `MSG#general#…`, so a range
  // ending at anything looser than `MSG#general$` swallows another thread's
  // whole conversation into this one.
  seed[`${journeyPk(journeyId)}|THREAD#general2`] = {
    PK: journeyPk(journeyId), SK: "THREAD#general2", threadId: "general2", title: "Other", createdAt: 1,
  };
  const c = makeContainer({ store: makeStore(seed) });

  const only = await putJourneyMessage(c, journeyId, T, { text: "hello", author: "alice@example.com" });
  const elsewhere = await putJourneyMessage(c, journeyId, "general2", { text: "not here", author: "alice@example.com" });

  for (const args of [{}, { before: "9999999999999-zzzzzz" }, { since: "0000000000000-000000" }]) {
    const page = await queryJourneyMessages(c, journeyId, T, args);
    assert.deepEqual(page.messages.map((m) => m.msgId), [only.msgId], JSON.stringify(args));
  }
  // …and the other thread sees only its own.
  const other = await queryJourneyMessages(c, journeyId, "general2", {});
  assert.deepEqual(other.messages.map((m) => m.msgId), [elsewhere.msgId]);
});

await test("threads: the default one is fixed-id and safe to create twice", async () => {
  const journeyId = "j-threads";
  const store = makeStore(channelSeed(journeyId));
  const c = makeContainer({ store });
  // The seed already has it; ensuring again must be a no-op rather than a
  // second "General". Two people opening a journey at once do exactly this.
  const again = await ensureDefaultThread(c, journeyId, "alice@example.com");
  assert.equal(again.threadId, DEFAULT_THREAD_ID);
  assert.equal((await listJourneyThreads(c, journeyId)).length, 1);

  const { created, thread } = await createJourneyThread(c, journeyId, {
    title: "Rollout",
    identity: "bob@example.com",
  });
  assert.equal(created, true);
  assert.notEqual(thread.threadId, DEFAULT_THREAD_ID, "a person's thread gets a uuid");
  assert.equal(thread.messageCount, 0);

  // General is pinned to the top whatever its activity — it is the thread
  // every journey has and where a message lands when nobody chose, so a list
  // where it drifts down is one where the default place to talk is hardest to
  // find. Everything else is most recently active first.
  await putJourneyMessage(c, journeyId, thread.threadId, { text: "hi", author: "bob@example.com" });
  assert.deepEqual(
    (await listJourneyThreads(c, journeyId)).map((t) => t.threadId),
    [DEFAULT_THREAD_ID, thread.threadId],
    "General stays first even though the other thread is the active one"
  );

  const { thread: third } = await createJourneyThread(c, journeyId, { title: "Later", identity: "bob@example.com" });
  await putJourneyMessage(c, journeyId, third.threadId, { text: "newest", author: "bob@example.com" });
  assert.deepEqual(
    (await listJourneyThreads(c, journeyId)).map((t) => t.threadId),
    [DEFAULT_THREAD_ID, third.threadId, thread.threadId],
    "and the rest sort newest-active first behind it"
  );

  assert.equal((await renameJourneyThread(c, journeyId, thread.threadId, { title: "Rollout plan" })).ok, true);
  const renamed = (await listJourneyThreads(c, journeyId)).find((t) => t.threadId === thread.threadId);
  assert.equal(renamed.title, "Rollout plan");
  assert.equal((await renameJourneyThread(c, journeyId, "nope", { title: "x" })).reason, "thread_not_found");
});

await test("unread is per thread, so reading one does not clear another", async () => {
  // The reason a journey-level cursor cannot be stored instead of a sum: it
  // would be advanced by reading one thread and would then hide every other
  // thread's unread.
  const journeyId = "j-rollup";
  const store = makeStore(channelSeed(journeyId));
  const c = makeContainer({ store });
  const { thread: other } = await createJourneyThread(c, journeyId, { title: "Other", identity: "alice@example.com" });
  const bob = "bob@example.com";

  const a = await putJourneyMessage(c, journeyId, T, { text: "one", author: "alice@example.com" });
  await putJourneyMessage(c, journeyId, other.threadId, { text: "two", author: "alice@example.com" });

  const roll = async () => {
    const threads = await listJourneyThreads(c, journeyId);
    const cursors = cursorsByThread(await listJourneyReadCursors(c, journeyId, bob));
    return journeyUnread(threads, cursors);
  };

  assert.equal((await roll()).unread, 2, "never opened: both threads are unread");

  await advanceJourneyReadCursor(c, journeyId, bob, T, { at: a.at, messageCount: 1 });
  const after = await roll();
  assert.equal(after.unread, 1, "the other thread is still unread");
  assert.equal(after.perThread[T].unread, 0);
  assert.equal(after.perThread[other.threadId].unread, 1);
});

await test("editJourneyMessage: author-only, and never resurrects a tombstone", async () => {
  const journeyId = "j-edit";
  const store = makeStore(channelSeed(journeyId));
  const c = makeContainer({ store });
  const msg = await putJourneyMessage(c, journeyId, T, { text: "teh plan", author: "alice@example.com" });

  // A lead may delete somebody's message but must never rewrite it — which is
  // why this is `not_message_author`, not the board's author-or-lead code.
  const byOwner = await editJourneyMessage(c, journeyId, T, msg.msgId, { text: "the plan", identity: "bob@example.com" });
  assert.equal(byOwner.ok, false);
  assert.equal(byOwner.reason, "not_message_author");

  const ok = await editJourneyMessage(c, journeyId, T, msg.msgId, { text: "the plan", identity: "alice@example.com" });
  assert.equal(ok.ok, true);
  assert.equal(ok.message.text, "the plan");
  assert.ok(ok.message.editedAt >= msg.at);
  // An edit is not a new message: the badge must not move for a typo fix.
  assert.equal(store.items.get(`${journeyPk(journeyId)}|THREAD#${T}`).messageCount, 1);

  const missing = await editJourneyMessage(c, journeyId, T, "0000000000000-nope00", { text: "x", identity: "alice@example.com" });
  assert.equal(missing.reason, "journey_message_not_found");

  await deleteJourneyMessage(c, journeyId, T, msg.msgId, { identity: "alice@example.com" });
  const afterDelete = await editJourneyMessage(c, journeyId, T, msg.msgId, { text: "back", identity: "alice@example.com" });
  assert.equal(afterDelete.ok, false);
  assert.equal(afterDelete.reason, "message_deleted");
});

await test("deleteJourneyMessage: soft, idempotent, author-or-lead, and the counter never moves", async () => {
  const journeyId = "j-del";
  const store = makeStore(channelSeed(journeyId));
  const c = makeContainer({ store });
  const mine = await putJourneyMessage(c, journeyId, T, { text: "oops", author: "bob@example.com" });

  assert.equal((await deleteJourneyMessage(c, journeyId, T, mine.msgId, { identity: "carol@example.com" })).reason, "not_message_author_or_lead");

  const byLead = await deleteJourneyMessage(c, journeyId, T, mine.msgId, { identity: "alice@example.com", isLead: true });
  assert.equal(byLead.ok, true);
  assert.equal(byLead.message.text, "", "the text is gone");
  assert.ok(byLead.message.deletedAt);

  // The row stays — a message that vanished from the middle of a conversation
  // would take its replies' context with it, and `messageCount` is the thing
  // the unread badge is differenced against.
  const row = store.items.get(`${journeyPk(journeyId)}|MSG#${T}#${mine.msgId}`);
  assert.ok(row, "the row survives");
  assert.equal(row.text, undefined, "REMOVEd, not blanked");
  assert.equal(row.deletedBy, "alice@example.com");
  assert.equal(store.items.get(`${journeyPk(journeyId)}|THREAD#${T}`).messageCount, 1);

  // Deleting twice is success, like every other remove/archive on a journey.
  assert.equal((await deleteJourneyMessage(c, journeyId, T, mine.msgId, { identity: "bob@example.com" })).ok, true);

  // A tombstone still occupies its place in the page, text emptied.
  const page = await queryJourneyMessages(c, journeyId, T, {});
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0].text, "");
  assert.ok(page.messages[0].deletedAt);
});

await test("advanceJourneyReadCursor: monotonic, and the unread count is a difference of two counters", async () => {
  const journeyId = "j-read";
  const store = makeStore(channelSeed(journeyId));
  const c = makeContainer({ store });
  const me = "bob@example.com";

  // Never opened: everything is unread, with no row to read.
  assert.equal(await getJourneyReadCursor(c, journeyId, me, T), null);

  const a = await putJourneyMessage(c, journeyId, T, { text: "one", author: "alice@example.com" });
  await putJourneyMessage(c, journeyId, T, { text: "two", author: "alice@example.com" });
  const metaAfterTwo = store.items.get(`${journeyPk(journeyId)}|META`);
  assert.equal(metaAfterTwo.messageCount - 0, 2, "unread before reading anything");

  const first = await advanceJourneyReadCursor(c, journeyId, me, T, { at: metaAfterTwo.lastMessageAt, msgId: a.msgId, messageCount: 2 });
  assert.equal(first.advanced, true);
  const cursor = await getJourneyReadCursor(c, journeyId, me, T);
  assert.equal(cursor.messageCountAtRead, 2);
  assert.equal(store.items.get(`${journeyPk(journeyId)}|META`).messageCount - cursor.messageCountAtRead, 0);

  // Two tabs racing, or a client replaying an older position after scrolling
  // up: an unread badge that could go back up on its own is worse than one
  // that is occasionally a moment stale.
  const stale = await advanceJourneyReadCursor(c, journeyId, me, T, { at: cursor.lastReadAt - 5000, messageCount: 0 });
  assert.equal(stale.advanced, false);
  const unchanged = await getJourneyReadCursor(c, journeyId, me, T);
  assert.equal(unchanged.messageCountAtRead, 2, "a stale write moved nothing");

  await putJourneyMessage(c, journeyId, T, { text: "three", author: "alice@example.com" });
  const meta = store.items.get(`${journeyPk(journeyId)}|META`);
  assert.equal(meta.messageCount - unchanged.messageCountAtRead, 1, "one unread");
});

// --- mentions and pinning (docs 20 §19.7, §19.8) ----------------------------

await test("resolveJourneyMentions: the journey's people, and nobody else", async () => {
  const journeyId = "j-mention";
  const seed = channelSeed(journeyId);
  seed[`${journeyPk(journeyId)}|ACCESSOR#bob@example.com`] = {
    PK: journeyPk(journeyId),
    SK: "ACCESSOR#bob@example.com",
    identity: "bob@example.com",
  };
  const store = makeStore(seed);
  const c = makeContainer({ store });
  const meta = seed[`${journeyPk(journeyId)}|META`];

  // The lead and the roster.
  assert.deepEqual(await resolveJourneyMentions(c, journeyId, T, meta, "@bob look at this"), ["bob@example.com"]);
  assert.deepEqual(await resolveJourneyMentions(c, journeyId, T, meta, "@alice look"), ["alice@example.com"]);
  assert.deepEqual(await resolveJourneyMentions(c, journeyId, T, meta, "@nobody look"), []);
  assert.deepEqual(await resolveJourneyMentions(c, journeyId, T, meta, "no mentions here"), []);

  // Somebody who has spoken here is mentionable even without a roster row —
  // "@" in a conversation means the people in it.
  await putJourneyMessage(c, journeyId, T, { text: "hi", author: "carol@example.com" });
  assert.deepEqual(await resolveJourneyMentions(c, journeyId, T, meta, "@carol too"), ["carol@example.com"]);

  // An email address written out in prose is not a mention of anyone.
  assert.deepEqual(await resolveJourneyMentions(c, journeyId, T, meta, "mail bob@example.com"), []);
});

await test("resolveJourneyMentions: a public journey accepts a full same-tenant address", async () => {
  // A public journey has no ACCESSOR# roster at all (membership is a tenant
  // match computed at read time) and the Gateway cannot enumerate a tenant, so
  // a full address is the only handle that can resolve for someone who has not
  // spoken here yet.
  const journeyId = "j-public";
  const seed = channelSeed(journeyId, { visibility: "public" });
  const c = makeContainer({ store: makeStore(seed) });
  const meta = seed[`${journeyPk(journeyId)}|META`];

  assert.deepEqual(await resolveJourneyMentions(c, journeyId, T, meta, "@dave@example.com hi"), ["dave@example.com"]);
  assert.deepEqual(await resolveJourneyMentions(c, journeyId, T, meta, "@dave hi"), [], "a bare handle cannot resolve");
  assert.deepEqual(await resolveJourneyMentions(c, journeyId, T, meta, "@eve@other.com hi"), [], "another tenant");
});

await test("mention counters: per person, never your own, and differenced against the cursor", async () => {
  const journeyId = "j-mcount";
  const store = makeStore(channelSeed(journeyId));
  const c = makeContainer({ store });
  const bob = "bob@example.com";
  const cursorOf = () => store.items.get(`${journeyPk(journeyId)}|READ#${bob}#${T}`);

  await putJourneyMessage(c, journeyId, T, { text: "@bob one", author: "alice@example.com", mentions: [bob] });
  assert.equal(cursorOf().mentionCount, 1);
  await putJourneyMessage(c, journeyId, T, { text: "@bob two", author: "alice@example.com", mentions: [bob] });
  assert.equal(cursorOf().mentionCount, 2);

  // Naming yourself must not raise your own badge.
  await putJourneyMessage(c, journeyId, T, { text: "note to @bob self", author: bob, mentions: [bob] });
  assert.equal(cursorOf().mentionCount, 2);

  // Unread mentions is the same O(1) difference the message badge uses.
  assert.equal((cursorOf().mentionCount || 0) - (cursorOf().mentionCountAtRead || 0), 2);
});

await test("a cursor row created by a mention can still be advanced", async () => {
  // The regression this exists for: being mentioned creates the READ# row with
  // a mentionCount and no lastReadAt. A guard of `attribute_not_exists(SK) OR
  // lastReadAt < :at` then evaluates a missing attribute — which is false — so
  // the cursor could never advance and the badge stuck at unread forever, for
  // exactly the people who had been mentioned.
  const journeyId = "j-stuck";
  const store = makeStore(channelSeed(journeyId));
  const c = makeContainer({ store });
  const bob = "bob@example.com";

  const m = await putJourneyMessage(c, journeyId, T, { text: "@bob hi", author: "alice@example.com", mentions: [bob] });
  const before = await getJourneyReadCursor(c, journeyId, bob, T);
  assert.equal(before.mentionCount, 1);
  assert.equal(before.lastReadAt, undefined, "the row exists but has never been read");

  const advanced = await advanceJourneyReadCursor(c, journeyId, bob, T, { at: m.at, messageCount: 1, mentionCount: 1 });
  assert.equal(advanced.advanced, true);
  const after = await getJourneyReadCursor(c, journeyId, bob, T);
  assert.equal(after.lastReadAt, m.at);
  assert.equal(after.mentionCountAtRead, 1, "the mention badge clears too");
});

await test("pinJourneyMessage: an ordinary board message, with provenance both ways", async () => {
  const journeyId = "j-pin";
  const store = makeStore(channelSeed(journeyId));
  const c = makeContainer({ store });
  const m = await putJourneyMessage(c, journeyId, T, { text: "ship date is fixed", author: "bob@example.com" });

  const pinned = await pinJourneyMessage(c, journeyId, T, m.msgId, { identity: "alice@example.com" });
  assert.equal(pinned.ok, true);

  const head = store.items.get(`${journeyPk(journeyId)}|BOARDMSG#${pinned.msgId}`);
  assert.equal(head.content, "ship date is fixed");
  assert.equal(head.createdBy, "alice@example.com", "the pinner, not the author");
  assert.equal(head.version, 1);
  assert.equal(head.archived, false);
  assert.equal(head.pinnedFrom, m.msgId, "forward provenance");
  assert.equal(store.items.get(`${journeyPk(journeyId)}|MSG#${T}#${m.msgId}`).pinnedAs, pinned.msgId, "back-reference");
  // It is a real board message: version chain and counter, like any other.
  assert.ok(store.items.get(`${journeyPk(journeyId)}|BOARDMSG#${pinned.msgId}#V#000001`));
  assert.equal(store.items.get(`${journeyPk(journeyId)}|META`).boardMessageCount, 1);

  // Idempotent: pinning twice returns the board message already there rather
  // than putting the same words on the board a second time.
  const again = await pinJourneyMessage(c, journeyId, T, m.msgId, { identity: "alice@example.com" });
  assert.equal(again.msgId, pinned.msgId);
  assert.equal(again.already, true);
  assert.equal(store.items.get(`${journeyPk(journeyId)}|META`).boardMessageCount, 1);
});

await test("pinJourneyMessage: a tombstone has nothing to pin", async () => {
  const journeyId = "j-pin-del";
  const store = makeStore(channelSeed(journeyId));
  const c = makeContainer({ store });
  const m = await putJourneyMessage(c, journeyId, T, { text: "oops", author: "bob@example.com" });
  await deleteJourneyMessage(c, journeyId, T, m.msgId, { identity: "bob@example.com" });

  const pinned = await pinJourneyMessage(c, journeyId, T, m.msgId, { identity: "bob@example.com" });
  assert.equal(pinned.ok, false);
  assert.equal(pinned.reason, "message_deleted");
  assert.equal(store.items.get(`${journeyPk(journeyId)}|META`).boardMessageCount, undefined);

  const missing = await pinJourneyMessage(c, journeyId, T, "0000000000000-nope00", { identity: "bob@example.com" });
  assert.equal(missing.reason, "journey_message_not_found");
});

console.log(`\n${passed} passed`);
