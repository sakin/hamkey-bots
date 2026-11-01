import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
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

const MAX_BODY = 32 * 1024;
const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json",
	".webmanifest": "application/manifest+json",
	".png": "image/png",
};

function json(res: ServerResponse, status: number, body: unknown) {
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY) throw new Error("too large");
		chunks.push(chunk as Buffer);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Builds the HTTP server. It does not listen; `listenLocal` does, and only on the loopback interface. */
export function createApp(options: AppOptions): Server {
	const { engine, threads } = options;

	async function api(req: IncomingMessage, res: ServerResponse, path: string) {
		const member = resolveMember(req.headers, { members: options.members, devIdentity: options.devIdentity });
		if (member === undefined) return json(res, 403, { error: "Unknown identity" });

		if (req.method === "GET" && path === "/api/me") {
			return json(res, 200, { member: { id: member.id, name: member.name }, bot: { name: primaryBotFor(member).name } });
		}
		if (req.method === "GET" && path === "/api/primary") {
			return json(res, 200, await engine.view(await threads.primaryThreadFor(member)));
		}
		if (req.method === "POST" && path === "/api/primary/messages") {
			let body: unknown;
			try {
				body = await readJson(req);
			} catch {
				return json(res, 400, { error: "Invalid body" });
			}
			const text = typeof (body as { text?: unknown })?.text === "string" ? (body as { text: string }).text.trim() : "";
			if (text === "") return json(res, 400, { error: "Message text is required" });
			const requestId = (body as { requestId?: unknown }).requestId;
			await engine.send(
				await threads.primaryThreadFor(member),
				text,
				typeof requestId === "string" && requestId !== "" ? `${member.id}:${requestId}` : randomUUID(),
			);
			return json(res, 202, { ok: true });
		}
		if (req.method === "GET" && path === "/api/primary/events") {
			const thread = await threads.primaryThreadFor(member);
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-store",
				connection: "keep-alive",
				"x-accel-buffering": "no",
			});
			const unsubscribe = await engine.subscribe(thread, (view) => {
				res.write(`data: ${JSON.stringify(view)}\n\n`);
			});
			const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 25_000);
			req.on("close", () => {
				clearInterval(keepAlive);
				unsubscribe();
			});
			return;
		}
		return json(res, 404, { error: "Not found" });
	}

	async function serveStatic(req: IncomingMessage, res: ServerResponse, path: string) {
		const root = options.webDir;
		if (root === undefined || (req.method !== "GET" && req.method !== "HEAD")) return json(res, 404, { error: "Not found" });
		const safe = normalize(path).replace(/^(\.\.[/\\])+/, "");
		let file = join(root, safe);
		if (!file.startsWith(root)) return json(res, 404, { error: "Not found" });
		const info = await stat(file).catch(() => undefined);
		if (info === undefined || info.isDirectory()) file = join(root, "index.html");
		const final = await stat(file).catch(() => undefined);
		if (final === undefined) return json(res, 404, { error: "Not found" });
		res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
		createReadStream(file).pipe(res);
	}

	return createServer((req, res) => {
		const path = new URL(req.url ?? "/", "http://localhost").pathname;
		// The web app's shell is public to anyone who can reach the port; only data is identity-gated.
		const handler = path.startsWith("/api/") ? api(req, res, path) : serveStatic(req, res, path);
		handler.catch((error) => {
			console.error(error);
			if (!res.headersSent) json(res, 500, { error: "Internal error" });
			else res.end();
		});
	});
}

/** Hamkey listens on loopback only, so identity headers cannot be forged from the network. */
export function listenLocal(server: Server, port: number): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
	});
}
