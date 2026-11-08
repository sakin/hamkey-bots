import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import { createApp, listenLocal } from "../src/server/app.ts";
import { openPiEngine } from "../src/server/chat/pi-engine.ts";
import type { ThreadView } from "../src/server/chat/engine.ts";
import type { Member } from "../src/server/members.ts";
import { TAILSCALE_LOGIN_HEADER } from "../src/server/identity.ts";
import { AskLog } from "../src/server/ask-log.ts";
import { Bots, loadBots } from "../src/server/bots.ts";
import { CardStore } from "../src/server/card-store.ts";
import { Exposure } from "../src/server/exposure.ts";
import type { AskRecord } from "../src/server/chat/ask-tool.ts";
import { LearnedNotes } from "../src/server/memory/learned-notes.ts";
import { FileMemory } from "../src/server/memory/file-memory.ts";
import type { CompactionSettings, PiEngineOptions } from "../src/server/chat/pi-engine.ts";
import { DailySpend } from "../src/server/spend.ts";
import { seedBots } from "../src/server/seed.ts";
import { Threads } from "../src/server/threads.ts";
import { FakeWeb } from "./fake-web.ts";
import type { WebAccess } from "../src/server/web/web-access.ts";
import { Push, type PushSender } from "../src/server/push.ts";
import { loadVapid } from "../src/server/web-push-sender.ts";
import { FakePush } from "./fake-push.ts";
import { pricedProvider } from "./priced-provider.ts";

export const ann: Member = { id: "ann", name: "Ann", tailscaleLogin: "ann@example.com" };
export const ben: Member = { id: "ben", name: "Ben", tailscaleLogin: "ben@example.com" };

export type Hamkey = Awaited<ReturnType<typeof startHamkey>>;

/** A fresh data folder with both Members and the example Bots: what an Operator's folder looks like on day one. */
export async function newDataDir() {
	const dataDir = await mkdtemp(join(tmpdir(), "hamkey-test-"));
	await writeFile(join(dataDir, "members.json"), JSON.stringify([ann, ben]));
	// The example Bots in the repository are fixtures: what a Member-made `bots` folder looks like.
	await cp(new URL("../examples/bots", import.meta.url), join(dataDir, "bots"), { recursive: true });
	return dataDir;
}

/**
 * A real Hamkey server on a random localhost port with temporary storage. Only the model is replaced, by Pi's faux
 * provider, so tests drive the same HTTP and streaming API a Member's phone does.
 */
export async function startHamkey(options: { devIdentity?: string; webDir?: string; dataDir?: string; extraBots?: object[]; extraModels?: string[]; contextWindow?: number; compaction?: CompactionSettings; /** US dollars each model response costs; free by default. */ pricePerResponse?: number; /** The daily spend limit; none by default. */ dailyLimitUsd?: number; /** The web the Research Bot uses; an empty fake by default. */ web?: WebAccess; /** Told what became of every Ask. */ recordAsk?: (entry: AskRecord) => void; /** Extra extensions, and the names of their tools that every Bot is then given; for crash tests. */ extensions?: PiEngineOptions["extensions"]; extraTools?: string[]; /** Crashes in a row before a task is parked. */ restartLimit?: number; /** Where pushes go; a recording fake by default (`hamkey.push`). */ push?: PushSender } = {}) {
	// Passing a `dataDir` from an earlier run, stopped with `keepData`, is a server restart.
	const dataDir = options.dataDir ?? (await newDataDir());
	// Seeded Bots, such as the meal planner, arrive the way they do in a real data folder. Safe on a restart.
	await seedBots(dataDir);
	for (const bot of options.extraBots ?? []) {
		await writeFile(join(dataDir, "bots", `${(bot as { id: string }).id}.json`), JSON.stringify(bot));
	}
	const memory = new FileMemory(dataDir);
	const cards = new CardStore(dataDir);
	const learned = new LearnedNotes(dataDir);
	const exposure = new Exposure(dataDir);
	const bots = new Bots(await loadBots(dataDir, [ann, ben]), [ann, ben], dataDir);
	const faux = fauxProvider({
		tokensPerSecond: 400,
		models:
			options.contextWindow === undefined && options.extraModels === undefined
				? undefined
				: [{ id: "faux-small", contextWindow: options.contextWindow }, ...(options.extraModels ?? []).map((id) => ({ id }))],
	});
	const askLog = new AskLog(dataDir, (id) => bots.name(id));
	const web = options.web ?? new FakeWeb();
	const sender = options.push ?? new FakePush();
	const vapid = await loadVapid(dataDir);
	const push = new Push({ dataDir, sender, publicKey: vapid.publicKey });
	push.watch(cards);
	let spend: DailySpend | undefined;
	const engine = await openPiEngine({
		storagePath: join(dataDir, "hamkey.sqlite"),
		provider: options.pricePerResponse === undefined ? faux.provider : pricedProvider(faux.provider, options.pricePerResponse),
		gate: () => spend!.refusal(),
		model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
		members: [ann, ben],
		memory,
		cards,
		learned,
		exposure,
		botName: (id) => bots.name(id),
		recordAsk: async (entry) => {
			await askLog.record(entry);
			options.recordAsk?.(entry);
		},
		compaction: options.compaction,
		memoryAccess: (binding) => {
			const access = bots.memoryAccess(binding);
			return access && options.extraTools ? { ...access, tools: [...access.tools, ...options.extraTools] } : access;
		},
		extensions: options.extensions,
		restartLimit: options.restartLimit,
		web,
	});
	spend = new DailySpend({ dataDir, limitUsd: options.dailyLimitUsd ?? Infinity, total: () => engine.totalSpend() });
	const server = createApp({
		push,
		members: [ann, ben],
		spend,
		memory,
		cards,
		exposure,
		askLog,
		engine,
		bots,
		threads: new Threads(dataDir, engine, bots),
		devIdentity: options.devIdentity,
		webDir: options.webDir,
	});
	const port = await listenLocal(server, 0);
	const base = `http://127.0.0.1:${port}`;

	/** A client acting as whoever the headers say. */
	function as(headers: Record<string, string>, memberId = "") {
		const request = (path: string, init: RequestInit = {}) =>
			fetch(base + path, { ...init, headers: { ...headers, "content-type": "application/json", ...init.headers } });

		async function read(bot: string, until: (view: ThreadView) => boolean, timeoutMs: number, opened: () => void) {
			const controller = new AbortController();
			const response = await request(`/api/bots/${bot}/events`, { signal: controller.signal });
			const views: ThreadView[] = [];
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const decoder = new TextDecoder();
				let buffer = "";
				for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
					buffer += decoder.decode(chunk, { stream: true });
					let end: number;
					while ((end = buffer.indexOf("\n\n")) !== -1) {
						const frame = buffer.slice(0, end);
						buffer = buffer.slice(end + 2);
						if (!frame.startsWith("data: ")) continue;
						views.push(JSON.parse(frame.slice(6)));
						opened();
						if (until(views.at(-1)!)) return views;
					}
				}
			} finally {
				clearTimeout(timer);
				controller.abort();
			}
			throw new Error(`Stream ended before the expected view. Saw: ${JSON.stringify(views.at(-1))}`);
		}

		const primaryId = `primary-${memberId}`;

		return {
			request,
			get: (path: string) => request(path),
			primary: primaryId,
			send: (text: string, requestId?: string, bot = primaryId) =>
				request(`/api/bots/${bot}/messages`, { method: "POST", body: JSON.stringify({ text, requestId }) }),
			/**
			 * Opens the live stream; the promise resolves with every view received once `until` holds. `ready` resolves
			 * when the first view has arrived, so a test can act without guessing how long the connection takes.
			 */
			stream(until: (view: ThreadView) => boolean, timeoutMs = 5000, bot = primaryId) {
				let opened!: () => void;
				const ready = new Promise<void>((r) => (opened = r));
				const done = read(bot, until, timeoutMs, opened);
				done.catch(() => opened());
				return Object.assign(done, { ready });
			},
		};
	}

	return {
		dataDir,
		engine,
		memory,
		cards,
		/** The push service the server sends through: a `FakePush` unless the test passed its own. */
		push: sender as FakePush,
		pushService: push,
		learned,
		server,
		faux,
		port,
		as,
		asTailscale: (login: string) => as({ [TAILSCALE_LOGIN_HEADER]: login }),
		ann: as({ [TAILSCALE_LOGIN_HEADER]: ann.tailscaleLogin }, ann.id),
		ben: as({ [TAILSCALE_LOGIN_HEADER]: ben.tailscaleLogin }, ben.id),
		async stop({ keepData = false } = {}) {
			server.closeAllConnections();
			await new Promise((r) => server.close(r));
			await engine.close();
			if (!keepData) await rm(dataDir, { recursive: true, force: true });
		},
	};
}
