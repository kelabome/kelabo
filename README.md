<p align="center">
  <img src="logo/mark_readme.png" width="180" alt="Kelabo logo">
</p>

<h1 align="center">Kelabo</h1>

<p align="center">
  Live rooms with transcription, an AI assistant that answers <em>into the meeting</em>,<br>
  minutes written for you, and a searchable archive of everything your team decided.
</p>

<p align="center">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-2aa4b8"></a>
  <a href="docs/self-hosting.md"><img alt="Self-hostable" src="https://img.shields.io/badge/self--host-AWS-2aa4b8"></a>
  <a href="https://kelabo.me"><img alt="Hosted at kelabo.me" src="https://img.shields.io/badge/hosted-kelabo.me-2aa4b8"></a>
</p>

---

Each live room is a **kelabo** — not quite a call, not quite a meeting, its own
kind — and that is the word the app, the code and the URLs use. Open source,
MIT. You can run the whole thing in your own AWS account, or use the hosted
service at [kelabo.me](https://kelabo.me). Same product either way; this README
is the guide to choosing.

## Two ways to run Kelabo

|  | **Self-hosting** | **[kelabo.me](https://kelabo.me)** |
|---|---|---|
| What it is | The full product deployed into *your* AWS account | The same product, operated as a hosted service |
| You need | An AWS account and real comfort deploying AWS services, a domain on Route 53, your own supplier accounts (Soniox *or* Deepgram, DeepSeek, optionally Cloudflare), and an approved SES production-access request | An email address |
| Time to first kelabo | An afternoon, mostly waiting on signups and certificates | Minutes |
| Functionality | Identical | Identical |
| Cost | Your own AWS + supplier bills (an idle deployment ≈ US$15–20/month) | Run **at cost**: prepaid top-up, per-call metered pricing with published rates, a weekly free allowance — no seats, no plans, no subscription |
| Data boundary | Everything stays in infrastructure you control | Hosted — though audio still never touches any Kelabo server, in either deployment (see [transcription](#how-transcription-works)) |

Neither path is the "right" one — they trade effort for control.

**Self-host if** you (or someone at your organisation) are genuinely familiar
with AWS. The [self-hosting guide](docs/self-hosting.md) walks from an empty
account to `kelabo.mycompany.com`, but be honest about what it takes:

- an AWS account with admin access, and comfort with a terminal, DNS, CDK
  deployments and an AWS bill (the stack is CloudFront + Lambda + one Fargate
  container + DynamoDB/S3);
- a domain (or delegated subdomain) whose DNS lives in a **Route 53 hosted
  zone** — if your domain is managed elsewhere and cannot be delegated, stop
  here;
- your own accounts and API keys with the suppliers: **Soniox or Deepgram**
  (speech-to-text), **DeepSeek** (the assistant and minutes; other
  OpenAI-compatible providers work), and optionally **Cloudflare Realtime**
  (conference audio/video at scale);
- an application to AWS for **SES production access** so sign-in emails reach
  your team — approval usually takes a day, refusals happen (there is a
  MailerSend fallback, but it is one more account and one more DNS setup).

None of this is exotic to someone who deploys to AWS regularly, and from then
on upgrades are `git pull && make deploy`. If that list reads like a normal
Tuesday, self-host — you get the identical feature set with the data boundary
inside your own account.

**Use [kelabo.me](https://kelabo.me) if** that list does not describe you — a
small business without its own managed domain, a team with nobody who wants to
own an AWS deployment, or anyone who just wants to try Kelabo before deciding.
Sign in with any email address (or Google/Apple) and you are in a kelabo
minutes later; guests can even join a room with nothing but a display name.
kelabo.me is run as a communication utility, **at cost**: you top up a prepaid
balance, each call is billed at the exact metered supplier cost plus small
published flat amounts, every account gets a weekly free allowance, and the
rate card and running figures are public on the site. No per-seat pricing, no
subscription, no invoice arriving later.

## The two ideas: kelabos and journeys

**A kelabo** is one live room: conference audio, live transcript, a chat, a
shared board the assistant posts to. When it ends it is archived — transcript,
board and generated minutes — and becomes a searchable record.

**A journey** is what carries memory *between* kelabos. Two people finish a
kickoff having made three decisions; three weeks later the follow-up kelabo
would normally start from nothing. Link both into a journey and the second
room starts with the first one's minutes, the journey's running description,
health/progress indicators, pinned board messages and pasted documents — all
visible to the people in the room *and* injected into the assistant's context,
so it answers from what the project already decided instead of researching it
again. A journey also keeps an append-only Q&A history: ask it a question
("what did we decide about the rollout?") and the answer is generated from
every linked kelabo's minutes and stored forever next to the question.
Journeys are many-to-many (a kelabo can belong to several), public to your
organisation or private to a chosen roster, and everything that happens in one
lands on a filterable timeline. Full design: [docs/20-journey.md](docs/20-journey.md).

## What you get

- **A live room** with conference audio, camera and screen share. Two
  transports: `sfu` (Cloudflare's edge, scales) or `mesh` — a "secure kelabo"
  where media stays peer-to-peer and **no server can decrypt it**.
- **Live transcription** as people speak, streamed browser → STT provider
  directly: the server receives transcripts, never audio.
- **Messages beside the transcript** — the room's chat, with history that
  survives leaving and re-entering, day dividers when a room outlives a day,
  and paging back through weeks of it.
- **An assistant in the room** that answers while the question still matters,
  onto a shared board. Address it directly with `@kelabo`.
- **Minutes, written for you**, and a searchable archive of every ended kelabo.
- **Journeys** — named containers that link related kelabos so decisions,
  documents and Q&A history carry from one meeting to the next.
- **Scheduling and invitations** — schedule a kelabo, invite by email, change
  the roster before it starts; cancellations and reschedules notify everyone.
- **Contacts and presence** — see who in your organisation is online, and ring
  them into a huddle straight from Contacts.
- **Bring your own coding agent.** Attach your own opencode or Claude Code
  session to a kelabo — it hears the transcript and answers onto the board.
- **Everything optional degrades, nothing jams.** No STT key? The room is
  typed messages and calls. No LLM? No assistant surface at all — not a broken
  one. No Cloudflare creds? Peer-to-peer calling still works. The capability
  ladder is a design rule, not an accident:
  [docs/19-optional-capabilities.md](docs/19-optional-capabilities.md).
- **An admin console, so day two is not a deploy.** `/admin` publishes the
  model, the transcription engine, the mail transport, every rate limit and TTL,
  and holds the supplier keys — live in seconds, versioned, with an author and a
  note on every change. What still needs a deploy is what CloudFormation reads
  at synth: the account, the domains, the machine sizes.
  [docs/23-operational-configuration.md](docs/23-operational-configuration.md).

## How transcription works

Your browser captures the mic (voice-activity gated) and streams audio
**directly to the speech-to-text provider** — Deepgram or Soniox, chosen per
deployment — using a short-lived token the server mints. **Audio never touches
Kelabo's infrastructure**, self-hosted or hosted: the server receives text.
Interim captions follow you live; a pure client-side composer seals them into
messages, and only sealed messages are persisted, fanned out to every
participant over SSE, and offered to the assistant. Speakers are authenticated
identities, or diarization labels when one mic covers a room. The whole
pipeline: [docs/13-transcript-lifecycle.md](docs/13-transcript-lifecycle.md).

## How the LLM helps

**During the meeting.** Every sealed message passes a cheap trigger gate (a
small model asking "does the room need something?"). On a hit, the main agent
— which holds the rolling transcript, its working memory and any journey
context — decides to stay silent or dispatch sub-agents that search the web
and query MCP servers, then post a concise answer card to the kelabo's board.
It stays quiet by default; `@kelabo` addresses it directly. Design:
[docs/components/14-agent-orchestration.md](docs/components/14-agent-orchestration.md).

**After the meeting.** The host can request minutes at any time, and when a
kelabo ends it is archived: minutes (summary, decisions, action items, open
questions), the full transcript and board go to your records, all searchable.
If the kelabo was linked to a journey, its minutes join the journey's context
for every future kelabo there — and anyone can ask the journey a question
later, building an append-only report history of what was asked and answered
across the whole sequence of meetings.

## Connecting your own coding agent

`npm i -g @kelabome/agents` attaches your own opencode or Claude Code session
to a kelabo: it hears the transcript, answers onto the board, and every
permission prompt stays in *your* terminal. Kelabo never runs your agent — it
hands it a channel. The agent can also read and write the journey a kelabo
belongs to (timeline, board, reports) through the same MCP tool surface. See
[connector/README.md](connector/README.md).

## How it is put together

| Piece | What it is | Docs |
|---|---|---|
| `spa/` | The web app — room, board, records, journeys. React + Vite, served from CloudFront | [01-spa](docs/components/01-spa.md) |
| `gateway/` | The live half: SSE fan-out, captions, calls, the in-room agent. Node on ECS Fargate | [03-gateway](docs/components/03-gateway.md) |
| `rest-api/` | The control plane: auth, kelabos, journeys, records, scheduling. Lambda | [02-rest-api](docs/components/02-rest-api.md) |
| `connector/` | The agent bridge — one package, one `kelabo` command, every runtime | [16-agent-bridge](docs/components/16-agent-bridge.md) |
| `contracts/` | Shared schemas and wire shapes; everything speaks these | [10-data-contracts](docs/10-data-contracts.md) |
| `infra/` | The whole deployment as CDK stacks | [07-cdk-infra](docs/components/07-cdk-infra.md) |

The architecture overview lives in [ARCHITECTURE.md](ARCHITECTURE.md); the
numbered design docs under [docs/](docs/) go deep on each subsystem —
transcript lifecycle, agent orchestration, conference RTC, journeys, data
flows.

## The five-minute tour

```bash
make bootstrap        # npm install in every package
make test             # every package's test suite, no AWS needed
make help             # everything is a make target
```

## Deploying for real

You need an AWS account, a Route 53 domain, and API keys for an STT provider
(Soniox or Deepgram) and an LLM provider (assistant + minutes). Put your own
address in `rootAdminEmail` — it is the one identity that can administer the
deployment, it is deploy-time on purpose, and leaving it empty fails closed, so
you get a console that refuses everyone. The
[self-hosting guide](docs/self-hosting.md) walks from an empty account to
`kelabo.mycompany.com`. Keys you skip just switch their capability off —
the deployment tells the app what it can run, and the app offers exactly that —
and you can fill them in later from `/admin` without touching a terminal.

From then on, upgrades are `git pull && make deploy`; changing how the
deployment *behaves* is a page in the app.

## License

[MIT](LICENSE).
