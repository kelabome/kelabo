# Kelabo at MTData - a 10-minute guide

**Kelabo** MTData deployment provides a meeting room with an AI assistant built in.

- **Where:** **http://kelabo.mtdata.be**
- **Who can sign in:** anyone with an `@mtdata.com.au` address. People outside MTData can join as guests, using a link or a code.
- **Code:** https://github.com/rwang-mtdata/kelabo

By the end of this page you will know what the words mean and how to run a kelabo. You will also be able to bring your own coding agent (opencode or Claude Code) into the room.

---

## 1. The words

| Word | What it is |
|---|---|
| **Kelabo** | One meeting. It has audio and video, a live transcript, a chat and a shared **board**. When it ends, the transcript, board and **minutes** are kept as a searchable record. The app, the URLs and this guide all call a meeting "a kelabo". |
| **Board** | The shared panel where the assistant posts answers and anyone can add notes. It holds the useful results of the meeting, kept separate from the chatter. |
| **Assistant** | The AI in the room, called **Kelabo**. It listens to the transcript and stays quiet unless it has something useful to say or someone asks it a question. |
| **Journey** | A long-running container for a piece of work: a project, an incident or a release. You link related kelabos to it. It carries the decisions, documents and notes from one meeting into the next. |
| **Leg** | A named, ongoing chat thread inside a journey. It works like a channel and persists between meetings, with unread badges and `@person` mentions. |
| **Trunk** | The default leg that every journey has. A message lands there when nobody picked a leg. It is always pinned at the top, and the other legs branch off it. |
| **Journey board** | A few curated, pinned messages on the journey, such as "Decision: we ship v2 on Friday". You can edit or archive them. |
| **Questions** | Ask the journey something, such as "what did we decide about retries?". The answer is written from everything in the journey and kept. |

In short: **a kelabo is one meeting, and a journey is the story across several meetings.** Legs are the conversation between those meetings, and the Trunk is the leg you get by default.

---

## 2. Signing in (email code)

1. Open **http://kelabo.mtdata.be**.
2. Type your MTData email. Your name alone is enough; the `@mtdata.com.au` part is filled in for you.
3. Click **Send code**. An email arrives with the subject *"`123456` is your Kelabo sign-in code"*.
4. Type the 6-digit code and click **Verify**.

About the code:

- It **expires in 10 minutes** and allows 5 wrong tries.
- You can ask for a new one after 30 seconds by clicking **Resend**.
- Check your junk folder if the email doesn't arrive. The sender is a Kelabo `mtdata.com.au` address.

Once signed in, you stay signed in for up to 60 days on that browser. **Settings → Sign out everywhere** ends every session at once.

**Guests** (customers, contractors) need no account and get no code. They open a join link, type their name, and choose:

- **Join the call + watch board**, or
- **Watch board only**.

---

## 3. Running a kelabo

### Start one now
1. In the left rail, click **New kelabo** and give it a title.
2. Optionally, pick a **Journey** to link the kelabo to.
3. Optionally, turn on **Secure kelabo** for peer-to-peer audio, which no server can decrypt. It allows at most 5 people, and the choice is fixed once the kelabo is created.
4. Click **Create kelabo**. You land in the **lobby**, where you can check your camera and microphone and copy the invite link.
5. Click **Start →**. Anyone waiting in the lobby is let in automatically.

### Schedule one
In the left rail, click **Schedule** and fill in:

- **Title**
- **When**
- **For how long**
- **Invite**: start typing a colleague's name to find them in the MTData directory. Any other email address works too.
- Optionally, a **Note** (the agenda) and a **Journey**.

Then click **Schedule and invite N**.

- Each invitee gets an **"Invitation: …"** email. It has **Accept / Decline** buttons that work in one click, a join link, and a calendar invite (`.ics`) that drops into Outlook.
- Changes are emailed automatically:
  - **Reschedule** sends "Rescheduled: …" and asks people to reply again.
  - **Edit invitees** sends "Removed: …" to anyone you take off.
  - **Cancel** sends "Cancelled: …".
- Replies show on the scheduled kelabo's page as **Coming / Can't make it / No reply yet**.
- The time is only a plan: you can click **Start now** whenever you like.
- About 30 seconds before the start time, Kelabo moves you to the kelabo's page if you have Kelabo open in a browser tab.
- There are **no reminder emails**. Rely on the calendar invite.

### Invite people
- **Before the kelabo:** share the link from the lobby or the scheduled page. Anyone with the link can RSVP or join, and they don't need an account.
- **During the kelabo:**
  - **Send icon → Invite someone** gives you the link, or a **6-character code** for someone to type at `kelabo.mtdata.be/enter`. The code is handy for reading out over the phone, but it only lasts 2 minutes.
  - **Add people** rings colleagues who are online right now. They get a Join / Decline pop-up, and the ring times out after 45 seconds. No email is sent.
- **Contacts:** this page shows who is online. Star your favourites, and click **Kelabo &lt;name&gt;** to start a call with someone straight away.

### In the room
- **Captions and transcript:** your browser sends your own microphone directly to the speech-to-text service.
  - Press `c` for captions, `t` for the transcript and `b` for the board.
  - Press `m` to mute and `v` to turn the camera on or off.
- **Mic menu:** language, **Speakers** (labels several voices on one mic as A, B…; you can rename them), and **Auto mute**, which mutes you when you switch tabs.
- **End kelabo** (host only) ends the kelabo for everyone. The assistant then writes the **minutes**, and the record appears under **Kelabos** in the left rail.
- **The record** has three tabs:
  - **Transcript**, which you can download as JSON.
  - **Board**.
  - **Minutes**: summary, topics, decisions, action items with owners, open questions, and what the assistant looked up.

---

## 4. Journeys

Create a journey from **New journey** in the left rail. Give it a title, an optional description, and a visibility:

- **Public:** everyone at MTData can see it and link kelabos to it.
- **Private:** only you and the people you add can see it.

The person who creates a journey is its **Lead**.

| Tab | Use it for |
|---|---|
| **Legs** | The ongoing chat. It starts in **Trunk**; add more legs per topic. Type `@kelabo …` to get the assistant's answer in the thread. A message can be pinned to the board. |
| **Kelabos** | Link past kelabos, or start or schedule a new one already linked. |
| **Board** | Pinned decisions and notes. You can edit or archive them, and earlier versions are kept. |
| **Documents** | Paste in text such as a spec, a plan or log excerpts. There is no file upload, and a document can't be edited once added. |
| **Questions** | Ask the journey a question; **Only me** keeps the answer private to you. |
| **Timeline** | Everything that happened on the journey, newest first. |
| **Helm** (Lead only) | Rename the journey, change who can see it, set **Assistant can post to the board**, mark it complete, or delete it. |

When a kelabo is linked to a journey, the in-room assistant **already knows the journey's context**: its description, pinned board, documents and earlier minutes. So you don't have to re-explain the project at every meeting.

Health is shown as **Full Steam / Shoal Waters / Anchored**, meaning green, amber and red.

---

## 5. How the AI helps

**Kelabo** is in every kelabo. By default it **stays silent**. It speaks up when:

- **You address it.** Say *"Kelabo, what's the default retry timeout?"* or type `@kelabo …` in the chat. Speech-to-text often mishears the name (as "Calabo", "Collabo" and so on); the assistant copes with that.
- **It can clearly answer a question the room is stuck on.**

What it can do:

- **Look things up** on the web, and in the MCP tool servers you configured in **Settings**, if **Use my MCP servers** is on.
- **Show its progress.** A card on the board says it's working, then turns into the answer, with sources.
- **Write the minutes** when the kelabo ends.
- **Remember** the journey's context, or your own past kelabos if you turn on **Let the assistant read my past kelabos**. A chip in the room shows everyone when this is on.
- **Answer between meetings:** use `@kelabo` in a journey leg, or ask the journey a question on the **Questions** tab.

---

## 6. Bring your own coding agent (opencode / Claude Code)

The built-in assistant knows the web and the journey. **Your own coding agent knows your code.**

You can attach the opencode or Claude Code session on your laptop to a kelabo. It then hears the transcript and posts to the board, and can answer questions like *"where is the CAN retry logic in fluxfaultd?"* from your actual checkout.

- Your model, your MCP servers (Jira, FluxOps, Bitbucket…) and your permissions stay on your machine.
- Kelabo only supplies a pairing token and a channel.
- Kelabo never approves a tool call for you; every permission prompt still appears in your terminal.
- While your agent is attached, it **replaces** the built-in assistant for that kelabo. The room shows an **agent · &lt;you&gt;** chip.

### Install and pair (once)
You need Node 20 or later.

```bash
npm i -g @kelabome/agents
kelabo setup --api http://kelabo.mtdata.be/api
```

`setup` does two things:

1. **Wires your agent in.** It adds a `kelabo` MCP server to `opencode.json` or `~/.claude.json`. Use `--runtime opencode`, `--runtime claude-code` or `--all` to choose. It records what it wrote so that `kelabo uninstall` can undo it exactly.
2. **Pairs this machine with your account.** It prints a code like `ABCD-EFGH` and opens **kelabo.mtdata.be/pair**. Sign in there, check the code, and approve. The agent is then allowed to *read transcripts of kelabos it joins* and *post to those boards as you*.

The pairing lasts 90 days. To revoke it, go to **Settings → Integrations → Coding agents → Revoke**.

### Start your agent through `kelabo`
Each runtime needs a launch flag that is easy to forget. If it's missing, nothing tells you: the agent still joins, but it hears nothing. Starting through `kelabo` adds the flags for you.

```bash
kelabo opencode                 # picks a free --port and turns on background subagents
kelabo claude                   # adds --dangerously-load-development-channels server:kelabo
kelabo claude -- --resume       # everything after -- goes to the agent unchanged
```

### Hook the session into a kelabo
- **opencode:** in the session you want in the meeting, type **`/kstart`**. The agent lists the kelabos you can join; pick one. Type **`/kend`** to detach.
- **Claude Code:** just ask it to join, for example *"join the kelabo"*. It calls `kelabo_join`, lists the kelabos, and you pick one. There is no `/kstart`.

**Before a meeting**, your agent can also join a *scheduled* kelabo. It reads the agenda note and the invitees, researches, and posts its findings to the board, so they are waiting when people arrive.

A prep session hears no transcript. To take part once the kelabo is live, join it again after it starts.

**Between meetings**, ask the agent to "join the journey". It can then:

- read the journey's legs, documents and minutes;
- add documents;
- post in legs;
- pin results to the journey board, but only if the Lead turned on **Assistant can post to the board**.

### Checking and removing

```bash
kelabo status                   # what is paired, wired and running, and what is missing
kelabo uninstall --all --purge  # remove the wiring and the local credential
npm rm -g @kelabome/agents
```

### Gotchas
- **Claude Code**
  - MTData claude subscription disables a feature needed, so you can not hook in.
  - Transcript only arrives with first-party Anthropic sign-in. If `CLAUDE_CODE_USE_BEDROCK` or `CLAUDE_CODE_USE_VERTEX` is set, your agent hears nothing.
  - Restart any Claude Code session that was already open before you ran `setup`.
- **opencode**
  - Never start it by hand without `--port`; it will hear nothing. Run `kelabo status` to check.
- **Both**
  - You can only attach to kelabos you host or were invited to.
- **Security**
  - Transcript reaches your agent marked *untrusted*. Guests may be in the room, and what they say is treated as data, not as instructions. Even so, don't run an agent with broad auto-approved permissions in a meeting with outsiders.

There is no remote MCP URL to paste into other tools. The bridge is a local stdio MCP server (`kelabo run`), started by opencode or Claude Code. It connects out to Kelabo over a secure WebSocket.

---

## 7. Quick reference

| I want to… | Do this |
|---|---|
| Meet right now | **New kelabo** → **Create** → **Start →** → share the link |
| Meet next Tuesday | **Schedule** → add invitees → they get an email with a calendar invite and Accept/Decline |
| Bring someone in mid-call | **Add people** (online colleagues) or **Invite someone** (link or 6-character code) |
| Ask the AI | Say "Kelabo, …" or type `@kelabo …` |
| Keep context across meetings | Create a **Journey** and link the kelabos to it |
| Chat between meetings | Journey → **Legs** (starts in **Trunk**) |
| Find what was decided | Kelabos → the record → **Minutes**, or Journey → **Questions** |
| Use my coding agent | `npm i -g @kelabome/agents` → `kelabo setup --api http://kelabo.mtdata.be/api` → `kelabo opencode` + `/kstart`, or `kelabo claude` |
| Clean up records | Settings → **Records retention**, or delete a record you hosted |

**Problems or ideas?** Kelabo @Rico Wang.

