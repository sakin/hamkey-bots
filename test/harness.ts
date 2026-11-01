import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createApp, listenLocal } from "../src/server/app.ts";
import { openPiEngine } from "../src/server/chat/pi-engine.ts";
import type { ThreadView } from "../src/server/chat/engine.ts";
import type { Member } from "../src/server/members.ts";
import { TAILSCALE_LOGIN_HEADER } from "../src/server/identity.ts";
import { Bots, loadBots } from "../src/server/bots.ts";
import { LearnedNotes } from "../src/server/memory/learned-notes.ts";
import { FileMemory } from "../src/server/memory/file-memory.ts";
import type { CompactionSettings } from "../src/server/chat/pi-engine.ts";
import { Threads } from "../src/server/threads.ts";

export const ann: Member = { id: "ann", name: "Ann", tailscaleLogin: "ann@example.com" };
export const ben: Member = { id: "ben", name: "Ben", tailscaleLogin: "ben@example.com" };

export type Hamkey = Awaited<ReturnType<typeof startHamkey>>;

/**
 * A real Hamkey server on a random localhost port with temporary storage. Only the model is replaced, by Pi's faux
 * provider, so tests drive the same HTTP and streaming API a Member's phone does.
 */
export async function startHamkey(options: { devIdentity?: string; webDir?: string; dataDir?: string; extraBots?: object[]; extraModels?: string[]; contextWindow?: number; compaction?: CompactionSettings } = {}) {
	// Passing a `dataDir` from an earlier run, stopped with `keepData`, is a server restart.
	const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), "hamkey-test-")));
	if (options.dataDir === undefined) {
		await writeFile(join(dataDir, "members.json"), JSON.stringify([ann, ben]));
		// The example Bots in the repository double as fixtures: they are what a live data folder's `bots` folder looks like.
		await cp(new URL("../examples/bots", import.meta.url), join(dataDir, "bots"), { recursive: true });
	}
	for (const bot of options.extraBots ?? []) {
		await writeFile(join(dataDir, "bots", `${(bot as { id: string }).id}.json`), JSON.stringify(bot));
	}
	const memory = new FileMemory(dataDir);
	const learned = new LearnedNotes(dataDir);
	const bots = new Bots(await loadBots(dataDir, [ann, ben]), [ann, ben], dataDir);
	const faux = fauxProvider({
		tokensPerSecond: 400,
		models:
			options.contextWindow === undefined && options.extraModels === undefined
				? undefined
				: [{ id: "faux-small", contextWindow: options.contextWindow }, ...(options.extraModels ?? []).map((id) => ({ id }))],
	});
	const models = createModels();
	models.setProvider(faux.provider);
	const engine = await openPiEngine({
		storagePath: join(dataDir, "hamkey.sqlite"),
		models,
		model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
		memory,
		learned,
		compaction: options.compaction,
		memoryAccess: (binding) => bots.memoryAccess(binding),
	});
	const server = createApp({
		members: [ann, ben],
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
		memory,
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
