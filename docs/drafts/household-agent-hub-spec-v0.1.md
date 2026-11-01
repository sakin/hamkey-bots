> Saved copy of the Claude Doc [Household Agent Hub: Spec v0.1](https://claude.ai/artifact/AV9oY7eUXCrYLiu6QTQ4Cw), revision 31, exported 2026-10-31. Draft input for grilling, not the final spec. The architecture diagram did not export and remains in the Claude Doc.

# Household Agent Hub: Spec v0.1

Oct 31, 2026

## Overview and goals

A private, self-hosted hub where you and your partner each have a primary bot, plus shared household bots, with durable memory, topic threads, and bots that delegate to each other. Pi Durable (experimental) is the proposed runtime.

**Goals**

- Each of you has a roster of bots, a primary bot plus specialists such as a trip planner or budgeting bot, and each bot has its own Grok Bot-style main thread and memory, with no need to manage context yourselves.
- Side threads spin up easily for a topic and report back to the bot's memory when closed.
- Shared household bots (meals, travel, home admin) work from a shared memory that neither of you has to maintain by hand.
- Private stays private: each primary bot controls what the other person's bot can ask for.
- New bots are cheap to create; new tools go through review.
- A single repo holds platform code, tools, skills, policy defaults, and starter templates, with pinned versions and a safe upgrade path.

**Non-goals (for now)**

- More than two users or any public access.
- Group chats with several bots in one thread.
- Bots that deploy their own code unreviewed.

* Deferred to a second round: routines (scheduled tasks) and background-task views, along with the other ideas borrowed from Muse and Dot beyond the first three phone screens.

- Deferred: bringing a bot fully into a thread as a standing participant (group-style). To be planned later.

## Decisions so far

**Agreed in conversation**

1. Two trusted users (you and your partner), not a public bot.
2. One hub: a single server and storage layer, with many bots and conversations inside it.
3. A bot is a spec (model, instructions, tool allowlist, scope); a thread is one conversation with a bot; memory is a separate layer.
4. Memory is split into household (shared), personal (one per person), and agent (per bot).
5. Each of you has a roster of bots, including a primary bot that acts as lead and front door. The two primary bots can talk to each other, and each decides what is exposed.
6. Each bot has one main thread plus easy-to-spawn side threads.
7. Closing a side thread saves a summary and lasting facts to the bot's memory. The full thread is archived and searchable by that bot, never loaded by default.
8. Multi-bot work is delegation through a lead bot, not group chat.
9. A repo holds platform code, tools, skills, policy defaults, and starter templates, with pinned versions for updates. Personal and shared bot specs live in the database.
10. A web UI, with a main conversation per bot and a way to add side threads.

**Proposed by me, not yet confirmed**

- Autosave on thread close, starting with a confirm prompt.
- Bots may create new agents as drafts; new tool code only through a reviewed PR.
- Separate SQLite files per memory scope for hard isolation.
- Policy enforcement in the server, not in prompts.

* Roster: each person has a primary bot plus specialists, which the primary bot creates as drafts you approve. Specialists are personal by default.
* Four change tiers (free, approval, reviewed PR, humans only), with `learned.md` kept separate from the spec.
* Specs live in the database with versioned history and an export button; git holds platform code, tools, starter templates, and infrastructure. Shared bots live in the database too, with household-level approval.
* Both of you share one main thread with each household bot.

- Shared bots get personal context by live asking through the gatekeeper first; profile cards come later if needed.

* @mentions: you can ask another bot one question inside a thread; bringing a bot in as a full participant is deferred.

- Bots show structured cards from a fixed catalog the server validates, not free-form UI.

## Architecture

One server hosts every bot, each memory scope is its own SQLite file, and the two primary bots talk only through a server-side policy check.

&#91;embedded content: architecture · 2 primary bots, shared household bots, 3 scoped stores\]

Primary bots also read household memory; household bots can reach nothing else. Either primary bot delegates to household bots; the arrow is drawn once for space.

## Tech stack

TypeScript end to end: a small Node or Bun server hosts Pi Durable, and a Svelte 5 web app talks to it.

| Layer | Choice | Why |
| --- | --- | --- |
| Agent runtime | Pi Durable (`@earendil-works/pi-durable`) on Node or Bun | TypeScript library; we write the server around it |
| Storage | SQLite | Pi Durable ships a SQLite storage backend |
| Server API | HTTP routes plus SSE or WebSocket | Browser sends messages and approvals; server streams `watchEvents` output (message and tool events) |
| Approvals | Pi Durable `beforeTool` hook | Blocks a tool call until the approval card is answered; covers the missing tool-approval step |
| Web app | Svelte 5 | Phone-first UI; shares types with the server |
| UI primitives | Bits UI | Headless, accessible, unstyled components (sheets, tabs, menus, popovers) |
| Styling | Tailwind CSS v4 | Lets us borrow and adapt shadcn-svelte components, which are built on Bits UI and Tailwind |

Considered and not chosen: Rust with WebAssembly (Leptos, Dioxus), since Pi Durable is TypeScript and the Svelte ecosystem is far larger; Rivet as a hosting wrapper, which may be revisited if we want hibernating agents or multi-client streaming without our own routes.

## Memory scopes and privacy

Scope lives in the data and is enforced by the server, so a bot cannot reach a layer it was never given. Each scope is a separate SQLite file.

| Scope | Contents | Who can read | Who can write |
| --- | --- | --- | --- |
| Household | Calendar, groceries, trips, budgets, home info, shared bot memory | Both of you, shared bots | Both of you, shared bots |
| Personal (you) | Your preferences, notes, private threads | Your primary bot and your own bots | Your bots, on your behalf |
| Personal (partner) | Same, for her | Her primary bot and her own bots | Her bots, on her behalf |
| Agent | A bot's instructions, skills, working notes | That bot | That bot |

**Rules**

- Personal bots read their own personal scope plus household. They never see the other person's scope.
- Shared bots read household only.
- Nothing crosses scopes unless someone explicitly shares it ("save this to household").
- Memory is curated and size-capped per scope, with an always-loaded summary file plus search for the long tail.
- Cross-bot requests carry the requester's identity, and cross-bot requests are logged where both of you can see them.

**Swappable memory.** Memory sits behind one small interface so it can be replaced after the first build without rewriting the app. Pi Durable installs extensions on a registry at startup, and installing one with the same name replaces the old one.

- The interface has four operations: load the always-on summary, save a fact, search, and forget.
- v1 is simple: per-scope memory files plus full-text search over archived threads.
- Any memory extension we adopt later must write into our three scopes, not into its own global folder.
- Memory extensions I found target the Pi coding agent, and I could not confirm they work with Pi Durable, so each would need testing and probably adapting.

## Threads and context

Every bot has one main thread that feels continuous, like Grok Bot, plus optional side threads for focused topics. The main thread is never reset by the user; the system keeps it small through compaction and memory.

**Main thread**

- Always on. Older turns are compacted into a summary; recent turns stay verbatim.
- Durable facts move out of the thread into the bot's memory file so compaction cannot lose them.
- Large documents and tool output are saved as files, with only a pointer and summary in the thread.

**Side threads**

1. You tap "new thread" on any bot. It opens with that bot's instructions and memory, plus a link to its parent.
2. When you close it (or it goes idle), a wrap-up step writes a summary, decisions, open to-dos, and lasting facts.
3. The summary goes into the bot's memory, and the main thread gets a one-line note.
4. The full thread is archived, never deleted.

**Recall.** The owning bot gets `search_threads` (full-text search over its own archive) and `open_thread` (pull in specific parts). Nothing from archived threads is in context by default, and search is limited to the bot's own scope.

**Bot vs thread.** Make a new bot when behavior, tools, or permissions differ. Make a new thread when only the topic differs.

**Shared bots and shared threads.** Each household bot has one shared main thread that both of you can use. The challenges, and how the design handles them:

- **Identity.** Every message is tagged with its sender, and the bot addresses whoever spoke.
- **Visibility.** Both of you see the whole thread, so the UI marks it as shared and nothing private belongs in it.
- **Simultaneous messages.** They queue in arrival order and each gets its own reply (to be tested).
- **Memory writes.** Anything saved from a shared thread goes to household memory only.
- **Involving your own bots.** The shared bot can ask the speaker's primary bot for context, such as dietary needs or availability, through the gatekeeper. Only exposure-listed facts come back, and since the answer appears in the shared thread, it counts as shared.
- **Private side threads.** Either of you can open a side thread with a shared bot. It is stored in your personal scope, and only a summary you approve goes to household memory.

**Shared bot flow (v1: live asking only).** Example: the meal planner.

1. You post "plan dinners for next week" in the shared thread, tagged as you.
2. The planner loads its own `learned.md` and household memory.
3. For personal context, such as who is home, it sends a request to each primary bot: topic, purpose, and who asked.
4. The server checks each request against that person's exposure list before their bot sees it. Each bot answers minimally, such as "home Mon, Wed, Thu", with no reasons.
5. The planner posts a draft in the thread. Both of you see it and can adjust it ("no fish Thursday").
6. At wrap-up, the plan and any new preferences go to household memory. They were said in the shared thread, so they are already shared.

Example exposure list (format is my design):

```yaml
expose:
  - topic: evening availability
    to: [household bots]
    detail: free/busy only
  - topic: dietary restrictions
    to: [meal-planner]
    detail: full
  - topic: health, finances, private threads
    to: nobody
```

Rules for v1:

- The exposure check applies to both of you, since every answer lands in a thread you both read.
- If your preferences conflict, the shared bot says so in the thread instead of quietly picking one.
- If a primary bot does not answer in time, the shared bot asks the person directly in the thread.
- Sensitive input goes through a private side thread; only a constraint you approve (such as "low-carb dinners") moves to the shared thread.
- Personal bots write to household memory only through an explicit "share this" step, at the approval tier.
- Every request and answer is logged where both of you can see it.

Deferred: publish-style household profile cards (stable facts like allergies, kept by each primary bot and approved by you), for speed and for when a bot is unreachable. We can add these once live asking has proven out.

## Bot-to-bot: gatekeeper and delegation

**Gatekeeper between primary bots.** Your primary bot is the front door to your private layer: other people's bots can only reach it, and your other personal bots stay private unless you expose them. When her bot asks it something:

1. The request arrives tagged with who is asking.
2. The server checks it against your exposure list (a rules file you control) before your bot sees it.
3. Your bot answers with information, never with access ("he's free Thursday", not the calendar).
4. The exchange is logged where both of you can see it. The same applies in the other direction.

**Delegation.** For multi-bot work you talk to one lead bot. It hands tasks to other bots through a task record that carries the requester's identity and a return path, then reports back to you in one conversation.

- Each delegated bot keeps its own memory of its part.
- A hop limit and a spend cap per delegated chain prevent bots from looping.
- Group chat with several bots in one thread is out of scope for now.

**@mentions (v1).** In any thread you can type `@` and a bot's name to ask another bot one question without leaving the thread.

- The thread's own bot stays the main one. The mentioned bot answers once, labeled with its own name, and does not take over the thread.
- By default it sees only your message. You can attach a thread summary with one tap. It never sees the host bot's private memory, and it keeps its own memory.
- You can mention bots in your roster and shared household bots. Mentioning your partner's bot goes through the gatekeeper, and only exposure-listed facts come back.
- A mentioned bot cannot mention others, so there are no loops, and each mention counts toward the same spend cap.
- Deferred: pulling a bot fully into a thread as a standing participant. To be planned later.

## Bot specs and self-editing

A bot is a spec plus two small things it maintains: `learned.md` and its memory. Specs live in the app's database with versioned history, and an export button writes them as files for anyone who wants to read or hand-edit. The format below is my design, not Pi Durable's.

```yaml
id: trip-planner
owner: you            # personal scope
status: active
version: 7
model: default
core:                 # changes need your approval
  role: Plan trips for us. Ask about budget and dates first.
  style: Concise, no more than 3 options at a time.
tools: [web_search, calendar_read, notes]
permissions:
  network: web_search_only
  shell: false
  files: own_folder
limits:
  spend_per_day: 2.00
  delegation_hops: 2
expose_to_partner: false
```

The bot's `learned.md` is a separate file, so the bot can keep tuning itself without creating a new spec version each time.

**Spec vs learned vs memory**

|  | Spec core | learned.md | Memory |
| --- | --- | --- | --- |
| Holds | Role, style, tools, permissions | This bot's habits and corrections, about 2 KB cap | Facts about you or the household, by scope |
| Example | Ask about budget first | Prefers trains under 5 hours | Italy trip planned for May |
| Changed by | Bot proposes, owner approves | The bot, freely | Bots, within scope rules |
| Loaded | Always | Always | Small summary always, rest searched |

**Change tiers**

| Tier | Covers | Who changes it |
| --- | --- | --- |
| 1: free | learned.md | The bot, instantly, logged and reversible |
| 2: approval | Core instructions, model, routines, adding an already-approved tool | Bot proposes; owner approves a plain card showing the change |
| 3: reviewed PR | New tool code, new permissions, infrastructure | Proposed by a bot or you; you merge |
| Humans only | Scope, spend limits, exposure settings | You; never a bot |

**Creating bots.** Your primary bot creates a specialist through a `create_agent` tool. The server validates it (approved tools only, scope no wider than yours), it appears as a draft with a preview card, and on approval it joins your roster with its own main thread. Your partner approves cards, never YAML. The server enforces the tier of each field, so a bot cannot talk its way past it.

**Shared bot specs.** Household bots such as the meal planner are stored in the database like personal ones and use the same change tiers. Approvals go to the household (either of you for routine changes), so your partner never needs a PR. The repo holds only the starter templates that create them.

**Common bots.** A third kind sits between personal and shared: one definition, one instance per person. The bot builder is the first example. Its spec lives in the database like any other and is upgraded once for both of you, but each of you opens your own private thread with it. Drafts and requests stay private, it keeps no shared history, and it reads only household settings such as spend limits and approved tools.

- A bot the builder creates belongs to whoever asked for it. It is personal by default and can be shared with the household later with one approval.
- Creating a bot is a one-tap approval (tier 2). Any new tool code, such as an avatar generator, goes through a reviewed PR (tier 3).
- The avatar generator is a tool the builder calls, not a bot. If the builder later needs memory, such as your style, that memory is personal.

## Agent builder and tool builder

Bots can be created by another bot because a bot is a spec file, not a program. Creating a bot and creating a tool carry very different risk, so they are separate jobs.

|  | Agent builder | Tool builder |
| --- | --- | --- |
| What it makes | A spec: model, instructions, tool allowlist, scope | New code that other bots can run |
| Risk | A poorly written prompt | Code with access to files, network, secrets, money |
| Default policy | Creates drafts; you approve before they go live | Proposes a PR only; never deploys itself |

**Guardrails for the tool builder**

- Works only inside a sandbox with no secrets, no access to your main data, and limited network.
- Output lands as a branch; CI runs tests and a lint for suspicious calls; you merge.
- Each tool declares what it touches (network, filesystem, secrets), and bots only get tools you grant them.
- Prefer skills (Markdown) and separate MCP servers over changes to core code.
- Text the builder reads from the web or messages is treated as untrusted, since it could steer what code it writes.

Pi Durable has no tool-approval step yet, so these guardrails come from our own setup.

## Cards

Bots can show structured cards instead of plain text. A card is data, not code: a bot calls a tool that returns a card type and its fields, and the app renders it from a fixed catalog. Pi Durable's docs say tools can send UI data, but how that surfaces in our client is unverified.

| Card | Shows | Actions |
| --- | --- | --- |
| Approval | Before and after of a proposed change | Approve, Reject, Edit |
| Choice | A question with a few options | Tap one option |
| Plan or list | A plan, such as next week's dinners | Tick, edit, reorder rows |
| Remembered | What the bot remembered for a reply | Forget an item |
| Cross-bot request | Who asked whom and what came back | View the log |
| Secret | A masked field for an API key | Save |

**Rules**

- The server validates every card against the catalog before it reaches the UI. Bots cannot send HTML or code.
- Taps send a structured action to the server, never text the bot has to interpret as a command.
- Cards that change things, such as approvals, are checked by the server against the change tiers, not by the bot.
- Secret fields are masked. The value goes to a secret store and never enters the thread or the bot's context.
- A card in a shared thread is shared content, so both of you see it.
- Deferred: file and link previews, charts, and richer layouts.

**Companion face.** Each bot shows a small character whose mood mirrors its existing status: idle, thinking, working, needs you, or asleep. On the home screen the companion is the face of your lead bot and speaks a one-line summary, with buttons that open the card it is waiting on. It adds no new state to build. Each bot gets its own tint, and your partner's is blue. With reduced motion on, the face stays still and the status is also written in words. Screens 6 and 7 on the canvas show it.

## Security, cost, and operations

**Security**

- Allowlist exactly two user IDs; no one else can message any bot.
- Give each bot only the tools it needs. Sandbox anything that runs commands.
- Secrets stay out of the repo and out of any sandbox the builder uses.
- Per-conversation and per-bot spend caps, plus a hop limit on delegation chains.

**Repo and updates**

- One repo holds starter templates, hand-written tools, skills, policy defaults, and the Dockerfile and compose file. Live bot specs, personal and shared, stay in the database. Runtime data (the SQLite files) stays out of git and is backed up.
- Pin Pi Durable to an exact version, since its API can change in minor releases.
- Dependency bot (Renovate or Dependabot) opens upgrade PRs. CI runs a test that interrupts a turn mid-run and checks recovery.
- Back up the SQLite files before every upgrade; one community release notes that older runtimes cannot reopen a database after an upgrade.
- Deploy by image digest.

## Build order, risks, and unverified assumptions

**Build order**

1. One bot, one main thread, SQLite storage, simple web chat.
2. Memory file, thread archive, search, and the first cards (approval, choice, remembered).
3. Side threads with wrap-up.
4. Partner's scope and the gatekeeper between the two primary bots.
5. Delegation, then the agent builder, then the tool builder (highest risk, last).

**Assumptions I have not verified**

- Mapping each memory scope to its own Pi Durable storage or harness is my design idea, not a documented pattern.
- Whether Pi Durable forks suit side threads is untested.
- I believe messages to one conversation queue while different conversations run in parallel, based on the docs' description of an inbox. Needs a test.
- Grok Bot's internals are private; my description comes from public coverage and docs.
- The community web UI and platform projects I found are unvetted.

* Whether community memory extensions (such as pi-hermes-memory) work with Pi Durable is unverified.

**Risks**

- Pi Durable is experimental and can change between minor releases.
- No tool-approval step yet, so permissions are our responsibility.
- Summaries lose detail, so wrap-ups need spot checks until trusted.
- Runaway bot loops can burn API credit quietly.

## User stories

Mark each story Confirmed, Needs change, or Drop, and comment where the wording is off.

| ID | Story | Acceptance check | Review |
| --- | --- | --- | --- |
| U1 | As you, I chat with my primary bot in one continuous thread without ever starting a new chat. | Messages across several days stay in the same thread, and the bot recalls my stated preferences. | Unreviewed |
| U2 | As you, I tell my bot to remember something. | The fact appears in its memory file and is known in a brand-new session. | Unreviewed |
| U3 | As you, I spawn a side thread on a topic. | "New thread" opens with the bot's memory loaded and a link back to the main thread. | Unreviewed |
| U4 | As you, I close a side thread and its outcome is saved. | A summary and lasting facts land in memory, the main thread gets a one-line note, and a confirm prompt shows at first. | Unreviewed |
| U5 | As you, I ask my bot about something from an old thread. | The bot searches its own archive and names the thread; nothing from the archive was in context beforehand. | Unreviewed |
| U6 | As your partner, I have my own primary bot that cannot see your private memory. | Asking her bot for your notes fails at the server, not only because the prompt says no. | Unreviewed |
| U7 | As your partner, my bot asks yours whether you are free Thursday. | Your bot replies with availability only; the exchange is logged and visible to both of you. | Unreviewed |
| U8 | As you, I choose which topics and bots are exposed to her bot. | I edit the exposure list, it takes effect without a redeploy, and unlisted topics are refused. | Unreviewed |
| U9 | As either of us, I use a shared household bot such as the meal planner. | Both of us can message it; it reads household memory only and cannot open either personal scope. | Unreviewed |
| U10 | As either of us, I chat while the other is chatting. | Neither conversation blocks the other, and replies never land in the wrong thread. | Unreviewed |
| U11 | As you, I ask one lead bot for a multi-step job and it delegates. | I send one request and get one reply; a task record shows which bot did what. | Unreviewed |
| U12 | As you, I am protected from bots looping or overspending. | A delegation chain stops at the hop limit or spend cap and tells me. | Unreviewed |
| U13 | As you, I ask the builder bot to create a new bot. | A draft spec is created but not live until I approve, and it can only use allowlisted tools. | Unreviewed |
| U14 | As you, I ask the builder to propose a new tool. | It opens a branch from a sandbox; no bot can run the tool until I merge. | Unreviewed |
| U15 | As either of us, I am unaffected when the server restarts mid-turn. | The conversation resumes, and tools not marked safe to re-run do not repeat side effects. | Unreviewed |
| U16 | As the operator, I upgrade Pi Durable safely. | A pinned-version PR passes the recovery test in CI, and a backup is taken before deploy. | Unreviewed |

**Added after the roster and shared-thread decisions**

| ID | Story | Acceptance check | Review |
| --- | --- | --- | --- |
| U17 | As you, I ask my primary bot to make a trip planner. | A draft card previews it; on approval it joins my roster with its own main thread, personal by default. | Unreviewed |
| U18 | As either of us, I switch between my bots. | A sidebar lists my bots, each keeps its own main thread, and side threads hang off any bot. | Unreviewed |
| U19 | As you, I let a bot tune its own habits. | learned.md changes instantly, the change is logged and reversible, and core instructions do not move. | Unreviewed |
| U20 | As your partner, I approve a bot's proposed change to its instructions. | I see a plain card with the change; nothing is applied until I approve. | Unreviewed |
| U21 | As either of us, I talk to a shared bot in the same main thread as the other. | Each message shows its sender, the bot replies to the right person, and both of us see everything. | Unreviewed |
| U22 | As either of us, I want a shared bot to use my preferences without exposing the rest. | The shared bot asks my primary bot through the gatekeeper and gets only exposure-listed facts; the exchange is logged. | Unreviewed |

**Shared bot flow**

| ID | Story | Acceptance check | Review |
| --- | --- | --- | --- |
| U23 | As either of us, I ask the meal planner for next week's dinners in the shared thread. | It asks each primary bot for evening availability, gets only free/busy back, and posts a draft both of us can see. | Unreviewed |
| U24 | As either of us, I am asked directly when the other person's bot does not answer. | After a timeout, the shared bot asks the person in the thread instead of guessing. | Unreviewed |
| U25 | As either of us, I see it when our preferences conflict. | The shared bot names the conflict in the thread and does not quietly pick one side. | Unreviewed |

**@mentions**

| ID | Story | Acceptance check | Review |
| --- | --- | --- | --- |
| U26 | As you, I type @Budget in another bot's thread to ask it one question. | A bot picker appears, Budget answers once labeled with its own name, and the thread's bot stays in charge. | Unreviewed |
| U27 | As you, I mention a bot without exposing my private notes. | The mentioned bot sees only my message unless I attach a summary, and never reads the host bot's memory. | Unreviewed |
| U28 | As you, I @mention my partner's bot. | The request goes through the gatekeeper, only exposure-listed facts come back, and the exchange is logged for both of us. | Unreviewed |

**Cards**

| ID | Story | Acceptance check | Review |
| --- | --- | --- | --- |
| U29 | As either of us, I tap a button on a card instead of typing. | The tap sends a structured action, the server validates it, and a bot cannot fake an approval through text. | Unreviewed |
| U30 | As you, I enter an API key on a secret card. | The field is masked, and the value never appears in the thread or in any bot's context. | Unreviewed |
| U31 | As either of us, I forget something a bot remembered with one tap. | Tapping the x on a remembered item removes it from memory and logs the change. | Unreviewed |

**Common bots and companion**

| ID | Story | Acceptance check | Review |
| --- | --- | --- | --- |
| U32 | As you, I ask the builder for a new bot in my own private thread. | Your partner cannot see the thread or your drafts. | Unreviewed |
| U33 | As either of us, I share a bot I made with the household. | One approval moves it to shared. Until then it stays personal. | Unreviewed |
| U34 | As either of us, I see my lead bot's companion face on the home screen. | The mood matches the bot's status, and the status is also written in words. | Unreviewed |
| U35 | As you, I tap the companion's button to jump to the bot that needs me. | It opens the waiting card in that bot's thread. | Unreviewed |

## Open questions

- [ ] Autosave on thread close: confirm prompt first, then automatic once summaries are trusted, or automatic from day one?
- [ ] Should household bots ever see summaries of personal threads? My default is no, with opt-in per person.
- [ ] Which chat surface besides the web UI (Telegram, Discord, Signal), or web only?
- [ ] Should the web UI work well on a phone? It was not discussed.
- [ ] Host: home machine or cheap VPS? (Language settled: TypeScript, see Tech stack.)
- [ ] Should her bot be able to see anything of yours by default, such as a shared calendar, or fully walled off?
- [ ] Is Pi Durable the right foundation, or is Hermes (ready-made memory, skills, and messaging gateway) a faster start?

* [ ] Shared threads: is it fine that both of you see everything said to a shared bot, with private side threads available?
* [ ] Specialist bots personal by default, with sharing as an explicit step (my assumption)?
* [ ] Spec storage: database with an export button (my proposal), or files in local git?

- [ ] @mentions: should a mentioned bot see only your message by default (my assumption), or also a thread summary?

* [ ] Companion: the face of the lead bot only, or does every bot get one? (Drawn with a tint per bot.)
* [ ] Companion: give it a name and personality, or keep it as "the companion"?
