// The behaviour behind the Kelabo Agent Tools (docs 16 §2.B).
//
// Every return value is prose, because the consumer is a language model. A tool
// that returns `{"ok":true}` teaches the model nothing about what to do next;
// one that returns the briefing turns `kelabo_join` into the context load.
import { createCardBook } from "./cards.js";
import { briefingEnvelope, relative } from "./envelope.js";

export function createTools({ tunnel, binding, adapter, api, log = () => {}, now = Date.now }) {
  // Cards this session has open on the board. See cards.js for why the
  // bookkeeping is separate and pure.
  const cards = createCardBook();
  // Filled by the briefing frame, which is what the Gateway sends on attach.
  let briefing = null;
  let attachError = null;

  tunnel.on("briefing", (frame) => {
    briefing = frame;
    attachError = null;
  });
  tunnel.on("rejected", (frame) => {
    attachError = frame.reason;
  });
  tunnel.on("kelabo", (frame) => {
    if (frame.event === "ended" && briefing?.kelaboId === frame.kelaboId) {
      briefing = null;
      // Forget open cards without announcing them. The kelabo is over: a
      // "gave up" card would arrive after the board stopped being watched, and
      // working cards are never archived anyway.
      cards.drain();
    }
  });

  /** One place that builds a contribution frame, so a working card, an answer
   *  and an abandoned one cannot drift apart on the wire. */
  function sendCard(fields) {
    const kelaboId = tunnel.attachedKelabo();
    if (!kelaboId) throw new Error("Not attached to a kelabo. Call kelabo_join first.");
    const sent = tunnel.send({
      type: "contribution",
      kelaboId,
      // Idempotency, so a retry after a dropped socket is not a second card on
      // everyone's board.
      ref: `${now()}-${Math.random().toString(36).slice(2, 8)}`,
      ...fields,
    });
    if (!sent) throw new Error("Not connected to Kelabo — nothing was delivered. Try again in a moment.");
    return kelaboId;
  }

  /** Land any card the agent has walked away from. Called from the paths that
   *  already run — a tool call, a transcript batch — rather than a timer. */
  function sweep() {
    for (const { ref, title } of cards.expire(now())) {
      log("card_abandoned", { card: ref });
      try {
        sendCard({
          card: ref,
          status: "skipped",
          title,
          reason: "The agent did not come back with an answer.",
        });
      } catch {
        // Not attached any more, or the socket is down. The card is already out
        // of the book either way; there is nothing else to do about it here.
      }
    }
  }

  async function join({ kelaboId } = {}) {
    if (!kelaboId) return listKelabos();

    briefing = null;
    attachError = null;
    const ref = await adapter.attach();
    const sent = tunnel.attach({
      kelaboId,
      runtime: adapter.runtime,
      sessionRef: ref.sessionRef || "",
      workspace: ref.workspace || "",
    });
    if (!sent) throw new Error("Not connected to Kelabo. The bridge is reconnecting; try again in a moment.");

    const frame = await waitForAttach();
    if (!frame) {
      if (attachError) throw new Error(explainRejection(attachError));
      throw new Error("Kelabo did not answer the attach request. Try again.");
    }
    log("joined", { kelaboId, status: frame.status });

    // The join result is the context load (docs 16 §2.B), so it carries three
    // things in the order they are needed.
    const parts = [];

    // 1. Whatever the runtime could not fit in its system prompt. Claude Code
    //    truncates MCP `instructions` at 2048 characters, which drops most of
    //    the operating brief; this is where the rest arrives, and a join is the
    //    first moment it can matter because nothing else starts transcript.
    const brief = adapter.brief?.();
    if (brief) parts.push(`<kelabo-brief>\n${brief}\n</kelabo-brief>`);

    // 2. The kelabo itself.
    parts.push(briefingEnvelope(frame));

    // 3. Anything the adapter knows is broken that nothing else will reveal.
    //    On Claude Code that is a session started without the channel, or a
    //    third-party provider that has none — both of which leave every tool
    //    working and deliver no transcript at all, so the join looks perfect
    //    and the agent then sits through the kelabo deaf. opencode has the
    //    same class of failure (a missing `--port`) but catches it at the
    //    /kstart handover, which Claude Code does not have.
    //
    //    Last, so it is the final thing read, and in the tool result rather
    //    than a log line: the developer at this terminal is the only one who
    //    can fix it, and the agent's own output is the only thing they are
    //    certainly reading.
    const caveat = adapter.caveat?.();
    if (caveat) {
      log("join_caveat", { kelaboId });
      parts.push(
        `<kelabo-warning>\n${caveat}\nTell the developer this, verbatim, before doing anything else.\n</kelabo-warning>`
      );
    }
    return parts.join("\n\n");
  }

  function waitForAttach(timeoutMs = 10000) {
    if (briefing) return Promise.resolve(briefing);
    return new Promise((resolve) => {
      const done = (v) => {
        clearTimeout(timer);
        tunnel.off("briefing", onBriefing);
        tunnel.off("rejected", onRejected);
        resolve(v);
      };
      const onBriefing = (f) => done(f);
      const onRejected = () => done(null);
      const timer = setTimeout(() => done(null), timeoutMs);
      timer.unref?.();
      tunnel.once("briefing", onBriefing);
      tunnel.once("rejected", onRejected);
    });
  }

  function explainRejection(reason) {
    switch (reason) {
      case "not_invited":
        return "You are not the host of that kelabo and were not invited to it.";
      case "kelabo_not_found":
        return "No such kelabo.";
      case "kelabo_ended":
        return "That kelabo has already ended.";
      case "agent_token_revoked":
        return "This agent's access was revoked in Kelabo settings. Run the `kelabo-opencode login` or `kelabo-claude login` command for whichever runtime this is, to pair again.";
      default:
        return `Kelabo refused the attach: ${reason}`;
    }
  }

  async function listKelabos() {
    const kelabos = await api.joinableKelabos();
    if (!kelabos.length) {
      return "You have no live or scheduled kelabos. Schedule one in the portal, or ask the host to invite you.";
    }
    const lines = kelabos.map((m) => {
      const when =
        m.status === "active"
          ? `live, started ${relative(m.startedAt)}`
          : `scheduled ${relative(m.scheduledAt)}`;
      return `- ${m.kelaboId}  ${m.title || "(untitled)"} — ${when}${m.isHost ? ", you host" : ""}`;
    });
    return [
      "Kelabos you can join:",
      ...lines,
      "",
      "Call kelabo_join with one of these kelaboIds. A scheduled kelabo has no transcript — you prepare for it and post findings; a live one streams transcript as it is spoken.",
    ].join("\n");
  }

  /** Put a card on the board saying this is being worked on, before there is
   *  anything to say. The room's half of a background lookup: without it, the
   *  gap between asking and answering is indistinguishable from being ignored. */
  async function working({ card, title, to, progress } = {}) {
    sweep();
    if (card && !cards.has(card)) throw new Error(unknownCard(card));
    const at = now();
    const heading = String(title || "").slice(0, 200);
    let ref = card;
    if (ref) cards.touch(ref, { title: heading, at });
    else ref = cards.open({ title: heading, at });

    sendCard({
      card: ref,
      status: "working",
      title: heading || cards.title(ref) || "Looking into that",
      ...(to ? { to: String(to).slice(0, 80) } : {}),
      ...(progress ? { progress: String(progress).slice(0, 200) } : {}),
    });
    return [
      `The board now shows this as in progress. Card reference: ${ref}`,
      `Pass card:"${ref}" to kelabo_post when you have the answer and it replaces this placeholder, rather than adding a second card. Call kelabo_working again with the same card to update the status line.`,
    ].join("\n");
  }

  const unknownCard = (card) =>
    `No open card "${card}" — it may have been abandoned, or the kelabo ended. Call kelabo_working with no card to open a new one, or kelabo_post with no card to post on its own.`;

  async function post({ markdown, title, to, kind, sources, card } = {}) {
    sweep();
    if (!markdown || !String(markdown).trim()) throw new Error("markdown is required and must not be empty.");
    if (card && !cards.has(card)) throw new Error(unknownCard(card));
    sendCard({
      ...(card ? { card } : {}),
      status: "done",
      markdown: String(markdown),
      ...(title ? { title: String(title).slice(0, 200) } : {}),
      ...(to ? { to: String(to).slice(0, 80) } : {}),
      ...(kind ? { kind } : {}),
      ...(Array.isArray(sources) && sources.length ? { sources: sources.slice(0, 20) } : {}),
    });
    if (card) cards.close(card);
    if (briefing?.status === "scheduled") {
      return "Posted. The kelabo has not started, so it will be on the board when participants arrive.";
    }
    return card ? "Posted to the kelabo board, replacing the in-progress card." : "Posted to the kelabo board.";
  }

  async function kelabo() {
    if (!briefing) return "Not attached to a kelabo. Call kelabo_join to see what is available.";
    const b = briefing;
    const lines = [
      `${b.title || "(untitled)"} — ${b.status}`,
      `Host: ${b.host}`,
      b.status === "scheduled" && b.scheduledAt ? `Starts ${relative(b.scheduledAt)}` : "",
      b.status === "active" && b.startedAt ? `Started ${relative(b.startedAt)}` : "",
      b.note ? `Agenda note: ${b.note}` : "",
      b.invitees?.length
        ? `Invited: ${b.invitees.map((i) => `${i.displayName} (${i.response})`).join(", ")}`
        : "",
      b.participants?.length ? `In the room: ${b.participants.map((p) => p.displayName).join(", ")}` : "",
      `Transcript waiting to be delivered: ${binding.pending()}`,
    ];
    return lines.filter(Boolean).join("\n");
  }

  async function board() {
    const kelaboId = tunnel.attachedKelabo();
    if (!kelaboId) throw new Error("Not attached to a kelabo. Call kelabo_join first.");
    const items = await tunnel.requestBoard(kelaboId);
    if (!items.length) return "The board is empty.";
    return items
      .map((i) => `[${new Date(i.at).toISOString()}] ${i.author} → ${i.to}: ${i.title}\n${i.markdown}`)
      .join("\n\n---\n\n");
  }

  /** The minutes of the host's past kelabos — the record the host opted to
   *  share with assistants at creation, identical to what the in-ECS agent is
   *  given. The framing lines below matter as much as the entries: without
   *  them the model treats a six-week-old decision as the current state. */
  async function history() {
    const kelaboId = tunnel.attachedKelabo();
    if (!kelaboId) throw new Error("Not attached to a kelabo. Call kelabo_join first.");
    const res = await tunnel.requestHistory(kelaboId);
    if (!res) throw new Error("Kelabo did not answer. Try again.");
    if (!res.enabled) {
      return "The host has not shared past kelabos with assistants (a per-kelabo opt-in at creation). There is no history to read.";
    }
    if (!res.entries.length) return "The host shares past kelabos, but none of them have minutes yet.";
    const rendered = res.entries
      .map((h) => {
        const when = h.endedAt ? new Date(h.endedAt).toISOString().slice(0, 10) : "date unknown";
        const lines = [`### ${h.title} (${when})`];
        if (h.summary) lines.push(h.summary);
        if (h.decisions?.length) lines.push(`Decisions: ${h.decisions.join("; ")}`);
        if (h.actionItems?.length) lines.push(`Action items: ${h.actionItems.join("; ")}`);
        return lines.join("\n");
      })
      .join("\n\n");
    return (
      "Minutes of the host's recent kelabos, newest first. A RECORD OF THE PAST, not the current state of anything: " +
      "a decision here may already have been reversed, an action item may be done. Say when a fact comes from an " +
      "earlier kelabo and name which one, and never volunteer these contents unprompted — some people in the room " +
      "were not at those kelabos.\n\n" +
      rendered
    );
  }

  async function minutes({ minutes: text } = {}) {
    if (!text || !String(text).trim()) throw new Error("minutes is required.");
    if (!binding.submitMinutes(String(text))) {
      // Being ignored silently is how an agent learns nothing. Tell it.
      throw new Error("Kelabo did not ask for minutes. Nothing was submitted.");
    }
    return "Minutes submitted. They are stored as the kelabo record and were not posted to the board.";
  }

  async function leave() {
    // Land anything still in progress while the tunnel is still up. After the
    // detach there is no way to say "that answer is not coming", and a spinner
    // nobody will ever finish is worse than a card that admits it.
    for (const { ref, title } of cards.drain()) {
      try {
        sendCard({ card: ref, status: "skipped", title, reason: "The agent left the kelabo." });
      } catch {}
    }
    const kelaboId = tunnel.detach();
    binding.reset();
    briefing = null;
    return kelaboId ? `Detached from ${kelaboId}.` : "Was not attached to a kelabo.";
  }

  // --- journey tools (docs 20 §12.2) ------------------------------------
  //
  // A kelabo may be linked to more than one journey, so none of these take a
  // required journeyId — an omitted one resolves against the kelabo's own
  // links Gateway-side, and `resolved` on the response says which of four
  // things happened. This helper renders the three outcomes every one of
  // them shares; a tool-specific `resolved` value (e.g. `journey_post`'s
  // `aiCanPost` gate) is handled by its own function instead.
  function explainJourneyResolution(res) {
    if (res.resolved === "no_journey") {
      return "This kelabo is not linked to any journey.";
    }
    if (res.resolved === "ambiguous") {
      const lines = res.journeys.map((j) => `- ${j.journeyId}  ${j.title || "(untitled)"}`);
      return ["This kelabo is linked to more than one journey:", ...lines, "", "Call again with journeyId set to one of these."].join("\n");
    }
    if (res.resolved === "journey_not_found") {
      return "That journeyId is not one this kelabo is linked to.";
    }
    return null; // "ok" — the caller renders its own payload.
  }

  function requireAttached() {
    const kelaboId = tunnel.attachedKelabo();
    if (!kelaboId) throw new Error("Not attached to a kelabo. Call kelabo_join first.");
    return kelaboId;
  }

  async function journeyInfo({ journeyId } = {}) {
    const kelaboId = requireAttached();
    const res = await tunnel.requestJourneyInfo(kelaboId, journeyId);
    if (!res) throw new Error("Kelabo did not answer. Try again.");
    const explained = explainJourneyResolution(res);
    if (explained) return explained;
    return [
      `${res.title || "(untitled journey)"} — ${res.visibility}, ${res.status}`,
      res.description || "(no description yet)",
      `Health: ${res.health || "unset"}  Progress: ${typeof res.progress === "number" ? res.progress + "%" : "unset"}`,
      `Kelabos: ${res.counts.kelaboCount}  Documents: ${res.counts.documentCount}  Reports: ${res.counts.reportCount}  Board messages: ${res.counts.boardMessageCount}`,
      `journeyId: ${res.journeyId}`,
    ].join("\n");
  }

  async function journeyTimeline({ journeyId, entryType, before, limit } = {}) {
    const kelaboId = requireAttached();
    const res = await tunnel.requestJourneyTimeline(kelaboId, { journeyId, entryType, before, limit });
    if (!res) throw new Error("Kelabo did not answer. Try again.");
    const explained = explainJourneyResolution(res);
    if (explained) return explained;
    if (!res.entries.length) return "The journey's timeline has nothing (yet) matching that.";
    const rendered = res.entries
      .map((e) => `[${new Date(e.at).toISOString()}] ${e.type}${e.actor ? ` (${e.actor})` : ""}: ${e.summary}`)
      .join("\n");
    return res.nextBefore ? `${rendered}\n\nMore available — call again with before:${res.nextBefore}.` : rendered;
  }

  async function journeyBoard({ journeyId } = {}) {
    const kelaboId = requireAttached();
    const res = await tunnel.requestJourneyBoard(kelaboId, journeyId);
    if (!res) throw new Error("Kelabo did not answer. Try again.");
    const explained = explainJourneyResolution(res);
    if (explained) return explained;
    if (!res.messages.length) return "The journey's board has no pinned messages.";
    return res.messages.map((m) => `- ${m.content}`).join("\n");
  }

  /** The agent's own synthesis, stored directly — no server-side LLM call.
   *  Read the journey's own content first with journeyInfo/journeyTimeline/
   *  journeyBoard and kelabo_history, then answer from that. */
  async function journeyReportSubmit({ journeyId, question, answer } = {}) {
    if (!question || !String(question).trim()) throw new Error("question is required.");
    if (!answer || !String(answer).trim()) throw new Error("answer is required.");
    const kelaboId = requireAttached();
    const res = await tunnel.submitJourneyReport(kelaboId, { journeyId, question, answer });
    if (!res) throw new Error("Kelabo did not answer. Try again.");
    const explained = explainJourneyResolution(res);
    if (explained) return explained;
    return `Report submitted and stored on the journey (reportId: ${res.reportId}).`;
  }

  async function journeyPost({ journeyId, content, msgId } = {}) {
    if (!content || !String(content).trim()) throw new Error("content is required.");
    const kelaboId = requireAttached();
    const res = await tunnel.postJourneyMessage(kelaboId, { journeyId, content, msgId });
    if (!res) throw new Error("Kelabo did not answer. Try again.");
    if (res.resolved === "ai_posting_disabled") {
      return "The journey's owner has not turned on assistant posting for this journey (aiCanPost is off). Nothing was posted.";
    }
    if (res.resolved === "message_not_found") {
      return "No such board message on this journey — it may have been archived or never existed.";
    }
    if (res.resolved === "already_archived") {
      return "That board message is archived and cannot be edited until it is unarchived.";
    }
    const explained = explainJourneyResolution(res);
    if (explained) return explained;
    return msgId ? `Journey board message edited (version ${res.version}).` : `Posted to the journey's board (msgId: ${res.msgId}).`;
  }

  return {
    join, post, working, kelabo, board, history, minutes, leave, sweep, briefing: () => briefing,
    journeyInfo, journeyTimeline, journeyBoard, journeyReportSubmit, journeyPost,
  };
}
