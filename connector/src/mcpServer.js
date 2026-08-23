// Contract B: the Kelabo Agent Tools (docs 16 §2.B).
//
// This is the standard surface, and the only part of the system every runtime
// sees identically. Keep it stable — it is what a third-party adapter is written
// against.
//
// On Claude Code this same server is also the *channel*: declaring
// `claude/channel` makes the runtime register a notification listener, which is
// how transcript is pushed into a running session. The capability is added by
// the Claude Code adapter rather than here, so opencode does not advertise a
// capability it cannot honour.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { PERSONA } from "./persona.js";

const TOOLS = [
  {
    name: "kelabo_join",
    description:
      "Attach this session to a kelabo. Call with no arguments to list the kelabos you can join — both live ones and scheduled ones you host or were invited to. Returns the kelabo briefing.",
    inputSchema: {
      type: "object",
      properties: {
        kelaboId: { type: "string", description: "The kelabo to join. Omit to list what is available." },
      },
    },
  },
  {
    name: "kelabo_post",
    description:
      "Post to the kelabo's shared board. This is the only thing participants see; everything else you say stays at this terminal. Keep it short.",
    inputSchema: {
      type: "object",
      properties: {
        markdown: { type: "string", description: "The body of the post." },
        title: { type: "string", description: "Short one-line title; the board renders the post collapsed under it." },
        to: { type: "string", description: 'Who it is for: "all", or a participant display name. Visible to everyone either way.' },
        kind: { type: "string", enum: ["answer", "link", "code", "clarify", "note"] },
        sources: {
          type: "array",
          description: "Where the answer came from.",
          items: {
            type: "object",
            properties: { title: { type: "string" }, url: { type: "string" } },
            required: ["title"],
          },
        },
        card: {
          type: "string",
          description:
            "The card reference returned by kelabo_working. Pass it and this answer replaces that in-progress card instead of adding a second one. Omit it to post on its own.",
        },
      },
      required: ["markdown"],
    },
  },
  {
    name: "kelabo_working",
    description:
      "Tell the kelabo you are looking into something, before you have the answer. Call this the moment you start work that will take more than a moment — a background subagent, a codebase search — then pass the card reference it returns to kelabo_post. Participants see a card marked in progress rather than silence, and it becomes the answer in place.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "What you are looking into, as a short line the room will recognise as their question.",
        },
        progress: { type: "string", description: "Optional one-line status, e.g. 'Searching the gateway for retry logic'." },
        to: { type: "string", description: 'Who it is for: "all", or a participant display name.' },
        card: { type: "string", description: "An existing card reference, to update its status line. Omit to open a new card." },
      },
      required: ["title"],
    },
  },
  {
    name: "kelabo_info",
    description: "What this session is currently attached to: title, status, timing, participants and RSVPs.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "kelabo_board",
    description:
      "Read what is already on the kelabo's board, including posts made by an earlier session preparing for this kelabo. Use it before posting to avoid repeating yourself.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "kelabo_history",
    description:
      "The minutes of the host's recent past kelabos: summaries, decisions, action items. Available only when the host opted in. Use it for questions that reach back — \"what did we decide last time\", \"who was picking that up\" — and say which kelabo a fact came from: it is a record of the past, not the current state.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "kelabo_minutes",
    description:
      "Submit the kelabo minutes. Only call this when Kelabo asks for them. Pass a single JSON object; it is stored as the kelabo record and is never posted to the board.",
    inputSchema: {
      type: "object",
      properties: { minutes: { type: "string", description: "The minutes as a JSON object." } },
      required: ["minutes"],
    },
  },
  {
    name: "kelabo_leave",
    description: "Detach from the kelabo. Transcript stops arriving.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "kelabo_journey_info",
    description:
      "Details of the journey this kelabo is linked to: title, visibility, status, description, health/progress, counts. If the kelabo is linked to more than one journey, lists them and asks you to call again with journeyId.",
    inputSchema: {
      type: "object",
      properties: {
        journeyId: { type: "string", description: "Which journey, if this kelabo is linked to more than one. Omit if there is only one." },
      },
    },
  },
  {
    name: "kelabo_journey_timeline",
    description:
      "The journey's timeline: description changes, status updates, kelabos linked/unlinked, reports, board messages and documents — newest first.",
    inputSchema: {
      type: "object",
      properties: {
        journeyId: { type: "string", description: "Which journey, if this kelabo is linked to more than one." },
        entryType: {
          type: "string",
          enum: ["description", "status", "kelabo_linked", "kelabo_unlinked", "report", "board_message", "document"],
          description: "Only entries of this kind.",
        },
        before: { type: "number", description: "Cursor: only entries strictly before this epoch-ms timestamp." },
        limit: { type: "number", description: "Max entries to return (default 20)." },
      },
    },
  },
  {
    name: "kelabo_journey_board",
    description: "The journey's pinned board messages — persistent notes, distinct from this kelabo's own board.",
    inputSchema: {
      type: "object",
      properties: {
        journeyId: { type: "string", description: "Which journey, if this kelabo is linked to more than one." },
      },
    },
  },
  {
    name: "kelabo_journey_report_submit",
    description:
      "Submit your own synthesis as a journey report, stored directly with no server-side LLM call. Use it to answer a free-text question from the journey's accumulated content — read it first with kelabo_journey_info, kelabo_journey_timeline, kelabo_journey_board and kelabo_history.",
    inputSchema: {
      type: "object",
      properties: {
        journeyId: { type: "string", description: "Which journey, if this kelabo is linked to more than one." },
        question: { type: "string", description: "The question this report answers." },
        answer: { type: "string", description: "Your synthesized answer." },
      },
      required: ["question", "answer"],
    },
  },
  {
    name: "kelabo_journey_post",
    description:
      "Write or edit a pinned message on the journey's board. Gated by the journey owner's aiCanPost setting, off by default — a clear refusal, not a silent no-op, when it is off.",
    inputSchema: {
      type: "object",
      properties: {
        journeyId: { type: "string", description: "Which journey, if this kelabo is linked to more than one." },
        content: { type: "string", description: "The message body." },
        msgId: { type: "string", description: "An existing message's id, to edit it in place. Omit to post a new one." },
      },
      required: ["content"],
    },
  },
];

const ok = (text) => ({ content: [{ type: "text", text }] });
const fail = (text) => ({ content: [{ type: "text", text }], isError: true });

/**
 * @param {{name:string, version:string, capabilities?:object,
 *          instructions?:string, handlers:object}} opts
 *   `handlers` implements the tools; `capabilities` lets the Claude Code
 *   adapter add `claude/channel` without this module knowing about channels;
 *   `instructions` comes from the adapter too, because how much of the persona
 *   survives is a runtime fact — Claude Code truncates it at 2048 characters
 *   (persona.js). Defaulting to the full text keeps every existing caller.
 */
export function createMcpServer({
  name = "kelabo",
  version = "1.0.0",
  capabilities = {},
  instructions = PERSONA,
  handlers,
}) {
  const server = new Server(
    { name, version },
    {
      capabilities: { tools: {}, ...capabilities },
      instructions,
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = req.params.arguments ?? {};
    try {
      switch (req.params.name) {
        case "kelabo_join":
          return ok(await handlers.join(args));
        case "kelabo_post":
          return ok(await handlers.post(args));
        case "kelabo_working":
          return ok(await handlers.working(args));
        case "kelabo_info":
          return ok(await handlers.kelabo());
        case "kelabo_board":
          return ok(await handlers.board());
        case "kelabo_history":
          return ok(await handlers.history());
        case "kelabo_minutes":
          return ok(await handlers.minutes(args));
        case "kelabo_leave":
          return ok(await handlers.leave());
        case "kelabo_journey_info":
          return ok(await handlers.journeyInfo(args));
        case "kelabo_journey_timeline":
          return ok(await handlers.journeyTimeline(args));
        case "kelabo_journey_board":
          return ok(await handlers.journeyBoard(args));
        case "kelabo_journey_report_submit":
          return ok(await handlers.journeyReportSubmit(args));
        case "kelabo_journey_post":
          return ok(await handlers.journeyPost(args));
        default:
          return fail(`unknown tool: ${req.params.name}`);
      }
    } catch (err) {
      // A thrown error reaches the model as a protocol error with no context.
      // An isError result reaches it as text it can act on, which for "you are
      // not attached to a kelabo" is the difference between recovering and
      // giving up.
      return fail(err.message || String(err));
    }
  });

  return {
    server,
    async start() {
      await server.connect(new StdioServerTransport());
    },
    async stop() {
      await server.close().catch(() => {});
    },
  };
}
