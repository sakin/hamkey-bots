import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { createAdaptorServer } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { type Bot, type BotKind, type BotInput, type Bots, InvalidBot } from "./bots.ts";
import type { ChatEngine, ThreadView } from "./chat/engine.ts";
import { BOT_TOOLS, DEFAULT_TOOLS } from "./memory/access.ts";
import type { Card, CardStore } from "./card-store.ts";
import { Exposure, InvalidExposure } from "./exposure.ts";
import { TOPICS, topicLabel } from "./memory/topics.ts";
import type { Memory } from "./memory/memory.ts";
import type { AskLog } from "./ask-log.ts";
import { InvalidSubscription, type Push, validateSubscription } from "./push.ts";
import { resolveMember } from "./identity.ts";
import type { Member } from "./members.ts";
import type { DailySpend } from "./spend.ts";
import { RESEARCH_BOT_ID } from "./research-bot.ts";
import { specFor, Threads } from "./threads.ts";

export type AppOptions = {
	members: readonly Member[];
	engine: ChatEngine;
	bots: Bots;
	threads: Threads;
	memory: Memory;
	cards: CardStore;
	/** Web Push subscriptions per Member and the key the browser subscribes with. */
	push: Push;
	exposure: Exposure;
	/** Every Ask and what became of it, which both Members may read. */
	askLog: AskLog;
	/** The daily spend limit; new messages are refused once it is reached. */
	spend: DailySpend;
	devIdentity?: string;
	webDir?: string;
};

type Env = { Variables: { member: Member } };

const MAX_BODY = 32 * 1024;
const KEEP_ALIVE_MS = 25_000;

/** Builds the HTTP server. It does not listen; `listenLocal` does, and only on the loopback interface. */
export function createApp(options: AppOptions): Server {
	const { engine, threads, bots, cards, memory, exposure } = options;

	const api = new Hono<Env>();

	// Every API route resolves the Member first, so no route can forget to.
	api.use("*", async (c, next) => {
		const member = resolveMember(c.req.header(), { members: options.members, devIdentity: options.devIdentity });
		if (member === undefined) return c.json({ error: "Unknown identity" }, 403);
		c.set("member", member);
		await next();
	});

	api.get("/me", (c) => {
		const member = c.get("member");
		// The development Member switcher needs the Member ids; they are offered only when a development identity is set.
		const devMembers = options.devIdentity === undefined ? undefined : options.members.map((m) => m.id);
		return c.json({ member: { id: member.id, name: member.name }, devMembers });
	});

	// Hand edits to the Bot files are picked up on the next request that touches Bots.
	api.use("/bots/*", async (c, next) => {
		await bots.reload();
		await next();
	});
	api.use("/bots", async (c, next) => {
		await bots.reload();
		await next();
	});

	const summary = (bot: Bot) => ({
		id: bot.id,
		name: bot.name,
		kind: bot.kind,
		// A Household Bot's thread is one that both Members write in.
		shared: bot.kind === "household",
		editable: bots.isEditable(bot),
		// Its answers come from web pages, so the Member is told to check them. Absent for every other Bot.
		web: bot.id === RESEARCH_BOT_ID ? true : undefined,
		// Set while the Bot's file is broken and its last working version is in use.
		warning: bots.hasProblem(bot.id) ? "This Bot's file has an error, so its last working version is in use." : undefined,
	});
	const definition = (bot: Bot) => ({
		...summary(bot),
		instructions: bot.instructions,
		model: bot.model ?? null,
		tools: bot.tools ?? [...DEFAULT_TOOLS],
	});

	// `waiting` is how many Cards in the Bot's thread wait for the requesting Member to act (the badge on the Bot).
	api.get("/bots", async (c) => {
		const member = c.get("member");
		const waiting = await cards.waitingFor(member.id);
		return c.json({ bots: bots.listFor(member).map((bot) => ({ ...summary(bot), waiting: waiting.filter((card) => card.botId === bot.id).length })) });
	});

	api.get("/push/key", (c) => c.json({ key: options.push.publicKey }));

	// A subscription is filed under the Member the server resolved, never a name in the body, so it cannot be set for the other Member.
	const PUSH_LIMIT = bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.json({ error: "Too large" }, 413) });
	api.post("/push/subscriptions", PUSH_LIMIT, async (c) => {
		try {
			await options.push.subscribe(c.get("member").id, validateSubscription(await c.req.json().catch(() => undefined)));
		} catch (error) {
			if (error instanceof InvalidSubscription) return c.json({ error: error.message }, 400);
			throw error;
		}
		return c.json({ ok: true }, 201);
	});

	api.delete("/push/subscriptions", PUSH_LIMIT, async (c) => {
		const body = await c.req.json().catch(() => undefined);
		if (typeof body?.endpoint !== "string") return c.json({ error: "An endpoint is required" }, 400);
		await options.push.unsubscribe(c.get("member").id, body.endpoint);
		return c.json({ ok: true });
	});

	api.get("/models", (c) =>
		c.json({ models: engine.listModels(), defaultModel: engine.defaultModel, tools: BOT_TOOLS, defaultTools: DEFAULT_TOOLS }),
	);

	const FORM_LIMIT = bodyLimit({ maxSize: MAX_BODY, onError: (c) => c.json({ error: "Too large" }, 413) });

	/**
	 * The requesting Member's own Exposure List, with the Topics and Bots it can name. There is no way to name another
	 * Member: the list is always the one of the Member the server resolved from the request's identity.
	 */
	const exposureView = async (member: Member) => ({
		exposure: await exposure.get(member.id),
		topics: TOPICS,
		bots: bots.askers().map((b) => ({ id: b.id, name: b.name, kind: b.kind })),
	});

	api.use("/exposure", async (c, next) => {
		await bots.reload();
		await next();
	});

	api.get("/exposure", async (c) => c.json(await exposureView(c.get("member"))));

	api.put("/exposure", FORM_LIMIT, async (c) => {
		const body = await c.req.json().catch(() => undefined);
		try {
			await exposure.set(c.get("member").id, body?.exposure, bots.askers().map((b) => b.id));
		} catch (error) {
			if (error instanceof InvalidExposure) return c.json({ error: error.message }, 400);
			throw error;
		}
		return c.json(await exposureView(c.get("member")));
	});

	/** Reads what a Member may set from a request body, or says what is wrong. */
	function readInput(body: unknown): BotInput | string {
		const b = (body ?? {}) as Record<string, unknown>;
		const input: BotInput = {
			name: b.name as string,
			instructions: b.instructions as string,
			model: b.model === null || b.model === "" ? undefined : (b.model as string | undefined),
			tools: b.tools as string[] | undefined,
		};
		if (input.model !== undefined && !engine.listModels().some((m) => m.id === input.model)) {
			return "That model is not in the catalog.";
		}
		return input;
	}

	api.post("/bots", FORM_LIMIT, async (c) => {
		const body = await c.req.json().catch(() => undefined);
		const input = readInput(body);
		if (typeof input === "string") return c.json({ error: input }, 400);
		try {
			const bot = await bots.create(c.get("member"), body?.kind as BotKind, input);
			return c.json(definition(bot), 201);
		} catch (error) {
			if (error instanceof InvalidBot) return c.json({ error: error.message }, 400);
			throw error;
		}
	});

	api.put("/bots/:bot", FORM_LIMIT, async (c) => {
		const input = readInput(await c.req.json().catch(() => undefined));
		if (typeof input === "string") return c.json({ error: input }, 400);
		try {
			const bot = await bots.update(c.get("member"), c.req.param("bot"), input);
			return bot === undefined ? notFound(c) : c.json(definition(bot));
		} catch (error) {
			if (error instanceof InvalidBot) return c.json({ error: error.message }, 400);
			throw error;
		}
	});

	// A Bot the Member may not use answers exactly like one that does not exist.
	const notFound = (c: Context) => c.json({ error: "Not found" }, 404);

	api.get("/bots/:bot/definition", (c) => {
		const bot = bots.find(c.get("member"), c.req.param("bot"));
		return bot === undefined ? notFound(c) : c.json(definition(bot));
	});

	/** What a client may know of a Card. The thread it sits in stays on the server. */
	const cardView = (card: Card, viewer: Member) => ({
		id: card.id,
		type: card.type,
		status: card.status,
		createdAt: card.createdAt,
		bot: { id: card.botId, name: bots.find(viewer, card.botId)?.name ?? card.botId },
		fields: card.type === "approval" ? { ...card.fields, topicLabel: topicLabel((card.fields as { topic: string }).topic) } : card.fields,
		choice: card.choice,
		resolvedBy: options.members.find((m) => m.id === card.resolvedBy)?.name,
	});

	/** Names each message's sender: a Member for the messages they wrote, the Bot for its replies. Adds the thread's Cards this Member may see. */
	const present = async (view: ThreadView, bot: Bot, thread: string, viewer: Member) => ({
		...view,
		// Work parked after repeated crashes would sit busy forever, so the Member is told and offered a retry.
		stuck: (await engine.parkedTasks(thread)).length > 0 ? true : undefined,
		messages: view.messages.map(({ author, ...m }) => {
			const member = author === undefined ? undefined : options.members.find((x) => x.id === author);
			const sender = m.role === "assistant" ? { id: bot.id, name: bot.name } : member && { id: member.id, name: member.name };
			return { ...m, sender, untrusted: m.role === "assistant" && bot.id === RESEARCH_BOT_ID ? true : undefined };
		}),
		cards: (await cards.inThread(thread, viewer.id)).map((card) => cardView(card, viewer)),
	});

	api.get("/bots/:bot", async (c) => {
		const found = await threads.mainThread(c.get("member"), c.req.param("bot"));
		return found === undefined ? notFound(c) : c.json(await present(await engine.view(found.thread), found.bot, found.thread, c.get("member")));
	});

	/**
	 * The Ask log, newest first. Both Members read all of it, Asks about the other Member included, because every answer was
	 * shared with a Bot in a conversation either of them may open. The one thing held back is the name of a Bot this Member
	 * may not use, which would show them a Bot the other keeps private.
	 */
	api.get("/asks", async (c) => {
		await bots.reload();
		const viewer = c.get("member");
		const name = (id: string | undefined) => options.members.find((m) => m.id === id)?.name;
		const entries = (await options.askLog.all()).map((e) => ({
			id: e.id,
			time: e.time,
			bot: bots.find(viewer, e.askerBotId)?.name ?? (bots.name(e.askerBotId) === undefined ? e.askerBotName : `A private Bot of ${name(e.askerMemberId ?? undefined) ?? "a Member"}`),
			about: name(e.targetMemberId) ?? null,
			topic: e.topic,
			topicLabel: topicLabel(e.topic),
			question: e.question,
			outcome: e.outcome,
			answer: e.answer,
			reason: e.reason,
		}));
		return c.json({ asks: entries });
	});

	// What waits for this Member to act, across all their threads. Badges and push are built on this.
	api.get("/cards", async (c) => {
		const member = c.get("member");
		return c.json({ cards: (await cards.waitingFor(member.id)).map((card) => cardView(card, member)) });
	});

	/**
	 * A tap on a Card. This is the only way a Card is approved or answered: the Member is the one the server resolved from
	 * their identity, never a name in the body, and nothing a Bot says reaches here. A Card that is unknown or not theirs
	 * answers 404 exactly alike.
	 */
	api.post("/cards/:card/actions", bodyLimit({ maxSize: 1024, onError: (c) => c.json({ error: "Too large" }, 413) }), async (c) => {
		const member = c.get("member");
		const body = await c.req.json().catch(() => undefined);
		const action = body?.action;
		if (action !== "approve" && action !== "reject" && action !== "choose") return c.json({ error: "Unknown action" }, 400);
		const card = await cards.get(c.req.param("card"));
		if (card === undefined || !card.addressees.includes(member.id)) return notFound(c);
		// A direct question has no buttons: only the Member writing in the thread settles it.
		if (card.type === "question") return c.json({ error: "That action does not fit this Card" }, 400);
		if ((card.type === "approval") !== (action !== "choose")) return c.json({ error: "That action does not fit this Card" }, 400);
		if (card.status !== "waiting") return c.json({ error: "This Card has already been answered" }, 409);
		const taken = () => c.json({ error: "This Card has already been answered" }, 409);

		if (card.type === "approval") {
			const fields = card.fields as { fact_id: string; topic: string };
			if (action === "reject") return (await cards.settle(card.id, "rejected", member.id)) === undefined ? taken() : c.json({ ok: true });
			// The Fact is looked up in its owner's personal memory only, whatever the Card says.
			const shared = await memory.setTopic([{ kind: "member", member: card.addressees[0]! }], fields.fact_id, fields.topic);
			if (!shared) {
				// The Fact was forgotten since the Card was posted; there is nothing left to share.
				await cards.settle(card.id, "rejected", member.id);
				return c.json({ error: "That fact no longer exists, so nothing was shared" }, 409);
			}
			return (await cards.settle(card.id, "approved", member.id)) === undefined ? taken() : c.json({ ok: true });
		}

		const choice = body.option;
		const fields = card.fields as { question: string; options: string[] };
		if (!Number.isInteger(choice) || choice < 0 || choice >= fields.options.length) return c.json({ error: "Pick one of the options" }, 400);
		const found = await threads.mainThread(member, card.botId);
		if (found === undefined || String(found.thread) !== card.thread) return notFound(c);
		// The pick wakes the Bot, so it is refused like a message once the daily limit is reached, and the Card stays waiting.
		const refusal = await options.spend.refusal();
		if (refusal !== undefined) return c.json({ error: refusal }, 429);
		if ((await cards.settle(card.id, "chosen", member.id, { choice })) === undefined) return taken();
		await engine.configure(found.thread, specFor(found.bot, found.memberId));
		await engine.sendCardAction(found.thread, `${member.name} chose: ${fields.options[choice]} (answering "${fields.question}")`, `card:${card.id}`, {
			card: card.id,
			action: "choose",
			by: member.id,
		});
		return c.json({ ok: true });
	});

	api.post(
		"/bots/:bot/messages",
		bodyLimit({ maxSize: MAX_BODY, onError: (c) => c.json({ error: "Message too large" }, 413) }),
		async (c) => {
			const member = c.get("member");
			const found = await threads.mainThread(member, c.req.param("bot"));
			if (found === undefined) return notFound(c);
			const body = await c.req.json().catch(() => undefined);
			const text = typeof body?.text === "string" ? body.text.trim() : "";
			if (text === "") return c.json({ error: "Message text is required" }, 400);
			// Refused before it is queued, so the Member keeps their text and sees why. Work already running is stopped by
			// the same limit before its next model request.
			const refusal = await options.spend.refusal();
			if (refusal !== undefined) return c.json({ error: refusal }, 429);
			const requestId = typeof body.requestId === "string" && body.requestId !== "" ? `${member.id}:${body.requestId}` : randomUUID();
			// The Bot may have been edited since this thread last ran; its next turn uses the current definition.
			await engine.configure(found.thread, specFor(found.bot, found.memberId));
			await engine.send(found.thread, text, requestId, { id: member.id, name: member.name }, found.memberId === undefined);
			// Writing in the thread is the answer to a Bot's direct question to this Member.
			await cards.answerQuestions(String(found.thread), member.id);
			return c.json({ ok: true }, 202);
		},
	);

	/**
	 * Runs a stuck thread's parked work again. Behind the same ownership check as messages: a Bot the Member may not use
	 * answers 404, and a thread with nothing parked answers 409.
	 */
	api.post("/bots/:bot/retry", async (c) => {
		const found = await threads.mainThread(c.get("member"), c.req.param("bot"));
		if (found === undefined) return notFound(c);
		return (await engine.retryParked(found.thread)) === 0 ? c.json({ error: "Nothing is stuck" }, 409) : c.json({ ok: true }, 202);
	});

	api.get("/bots/:bot/events", async (c) => {
		const found = await threads.mainThread(c.get("member"), c.req.param("bot"));
		if (found === undefined) return notFound(c);
		const { thread, bot } = found;
		const member = c.get("member");
		return streamSSE(c, async (stream) => {
			// A tap changes Cards without the conversation committing anything, so Card changes re-send the latest view too.
			let latest: ThreadView | undefined;
			let sending: Promise<unknown> = Promise.resolve();
			const push = () => {
				sending = sending
					.then(async () => {
						if (latest !== undefined) await stream.writeSSE({ data: JSON.stringify(await present(latest, bot, thread, member)) });
					})
					.catch(() => {});
			};
			const unsubscribe = await engine.subscribe(thread, (view) => {
				latest = view;
				push();
			});
			const unwatchCards = cards.subscribe((card) => {
				if (card.thread === String(thread)) push();
			});
			const keepAlive = setInterval(() => void stream.write(": keep-alive\n\n").catch(() => {}), KEEP_ALIVE_MS);
			const release = () => {
				clearInterval(keepAlive);
				unwatchCards();
				unsubscribe();
			};
			// The callback must stay pending until the client goes, or the stream closes.
			await new Promise<void>((resolve) => {
				stream.onAbort(resolve);
				if (stream.aborted) resolve();
			});
			release();
		});
	});

	// An unknown API path must not fall through to the web app's index.html.
	api.all("*", (c) => c.json({ error: "Not found" }, 404));

	const app = new Hono();
	app.route("/api", api);
	if (options.webDir !== undefined) {
		// The app shell is public to anyone who can reach the port; only data is identity-gated.
		app.use("*", serveStatic({ root: options.webDir }));
		app.get("*", serveStatic({ root: options.webDir, path: "index.html" }));
	}
	app.notFound((c) => c.json({ error: "Not found" }, 404));
	app.onError((error, c) => {
		console.error(error);
		return c.json({ error: "Internal error" }, 500);
	});

	// pi-ai makes its own outbound fetch calls, so leave the global Request and Response alone.
	return createAdaptorServer({ fetch: app.fetch, overrideGlobalObjects: false }) as Server;
}

/** Hamkey listens on loopback only, so identity headers cannot be forged from the network. */
export function listenLocal(server: Server, port: number): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
	});
}
