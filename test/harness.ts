import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createApp, listenLocal } from "../src/server/app.ts";
import { openPiEngine } from "../src/server/chat/pi-engine.ts";
import type { ThreadView } from "../src/server/chat/engine.ts";
import type { Member } from "../src/server/members.ts";
import { TAILSCALE_LOGIN_HEADER } from "../src/server/identity.ts";
import { Threads } from "../src/server/threads.ts";

export const ann: Member = { id: "ann", name: "Ann", tailscaleLogin: "ann@example.com" };
export const ben: Member = { id: "ben", name: "Ben", tailscaleLogin: "ben@example.com" };

export type Hamkey = Awaited<ReturnType<typeof startHamkey>>;

/**
 * A real Hamkey server on a random localhost port with temporary storage. Only the model is replaced, by Pi's faux
 * provider, so tests drive the same HTTP and streaming API a Member's phone does.
 */
export async function startHamkey(options: { devIdentity?: string } = {}) {
	const dataDir = await mkdtemp(join(tmpdir(), "hamkey-test-"));
	await writeFile(join(dataDir, "members.json"), JSON.stringify([ann, ben]));
	const faux = fauxProvider({ tokensPerSecond: 400 });
	const models = createModels();
	models.setProvider(faux.provider);
	const engine = await openPiEngine({
		storagePath: join(dataDir, "hamkey.sqlite"),
		models,
		model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
	});
	const server = createApp({
		members: [ann, ben],
		engine,
		threads: new Threads(dataDir, engine),
		devIdentity: options.devIdentity,
	});
	const port = await listenLocal(server, 0);
	const base = `http://127.0.0.1:${port}`;

	/** A client acting as whoever the headers say. */
	function as(headers: Record<string, string>) {
		const request = (path: string, init: RequestInit = {}) =>
			fetch(base + path, { ...init, headers: { ...headers, "content-type": "application/json", ...init.headers } });
		return {
			get: (path: string) => request(path),
			send: (text: string, requestId?: string) =>
				request("/api/primary/messages", { method: "POST", body: JSON.stringify({ text, requestId }) }),
			/** Opens the live stream; `until` resolves with every view received once the predicate holds. */
			async stream(until: (view: ThreadView) => boolean, timeoutMs = 5000): Promise<ThreadView[]> {
				const controller = new AbortController();
				const response = await request("/api/primary/events", { signal: controller.signal });
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
							if (until(views.at(-1)!)) return views;
						}
					}
				} finally {
					clearTimeout(timer);
					controller.abort();
				}
				throw new Error(`Stream ended before the expected view. Saw: ${JSON.stringify(views.at(-1))}`);
			},
		};
	}

	return {
		dataDir,
		server,
		faux,
		port,
		as,
		asTailscale: (login: string) => as({ [TAILSCALE_LOGIN_HEADER]: login }),
		ann: as({ [TAILSCALE_LOGIN_HEADER]: ann.tailscaleLogin }),
		ben: as({ [TAILSCALE_LOGIN_HEADER]: ben.tailscaleLogin }),
		async stop() {
			server.closeAllConnections();
			await new Promise((r) => server.close(r));
			await engine.close();
			await rm(dataDir, { recursive: true, force: true });
		},
	};
}
