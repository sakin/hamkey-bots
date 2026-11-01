import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { createAdaptorServer } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { ChatEngine } from "./chat/engine.ts";
import { resolveMember } from "./identity.ts";
import type { Member } from "./members.ts";
import { primaryBotFor } from "./primary-bot.ts";
import { Threads } from "./threads.ts";

export type AppOptions = {
	members: readonly Member[];
	engine: ChatEngine;
	threads: Threads;
	devIdentity?: string;
	webDir?: string;
};

type Env = { Variables: { member: Member } };

const MAX_BODY = 32 * 1024;
const KEEP_ALIVE_MS = 25_000;

/** Builds the HTTP server. It does not listen; `listenLocal` does, and only on the loopback interface. */
export function createApp(options: AppOptions): Server {
	const { engine, threads } = options;

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
		return c.json({ member: { id: member.id, name: member.name }, bot: { name: primaryBotFor(member).name } });
	});

	api.get("/primary", async (c) => c.json(await engine.view(await threads.primaryThreadFor(c.get("member")))));

	api.post(
		"/primary/messages",
		bodyLimit({ maxSize: MAX_BODY, onError: (c) => c.json({ error: "Message too large" }, 413) }),
		async (c) => {
			const member = c.get("member");
			const body = await c.req.json().catch(() => undefined);
			const text = typeof body?.text === "string" ? body.text.trim() : "";
			if (text === "") return c.json({ error: "Message text is required" }, 400);
			const requestId = typeof body.requestId === "string" && body.requestId !== "" ? `${member.id}:${body.requestId}` : randomUUID();
			await engine.send(await threads.primaryThreadFor(member), text, requestId);
			return c.json({ ok: true }, 202);
		},
	);

	api.get("/primary/events", async (c) => {
		const thread = await threads.primaryThreadFor(c.get("member"));
		return streamSSE(c, async (stream) => {
			const unsubscribe = await engine.subscribe(thread, (view) => {
				void stream.writeSSE({ data: JSON.stringify(view) }).catch(() => {});
			});
			const keepAlive = setInterval(() => void stream.write(": keep-alive\n\n").catch(() => {}), KEEP_ALIVE_MS);
			const release = () => {
				clearInterval(keepAlive);
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
