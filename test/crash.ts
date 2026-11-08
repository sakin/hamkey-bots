/**
 * Helpers for tests that kill the server for real: Hamkey runs as a child process (`fixtures/faux-server.ts`) and the
 * test sends it SIGKILL, so nothing is closed or cleaned up, as in a power cut or an out-of-memory kill.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TAILSCALE_LOGIN_HEADER } from "../src/server/identity.ts";
import type { ServerConfig, Step } from "./fixtures/faux-server.ts";
import { ann, ben, newDataDir } from "./harness.ts";

export type { Step };

const ROOT = new URL("..", import.meta.url).pathname;
const FIXTURE = new URL("./fixtures/faux-server.ts", import.meta.url).pathname;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until `check` returns something other than undefined or false. */
export async function eventually<T>(check: () => Promise<T | false | undefined> | T | false | undefined, what: string, timeoutMs = 20_000): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const found = await check();
		if (found !== false && found !== undefined) return found;
		if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
		await sleep(50);
	}
}

export type Messages = { id: string; role: string; text: string }[];
export type View = { messages: Messages; busy: boolean; error?: string; stuck?: boolean; cards: { id: string; type: string; status: string; fields: Record<string, unknown> }[] };

/** One server process on a data folder. Kill it with `kill()`; the test cleans up the rest. */
export class Server {
	constructor(
		readonly child: ChildProcess,
		readonly port: number,
		readonly control: string,
	) {}

	/** SIGKILL: the process dies at once and closes nothing. Resolves when it is gone. */
	async kill() {
		const exited = new Promise((r) => this.child.once("exit", r));
		this.child.kill("SIGKILL");
		await exited;
	}

	/** A request as `member`. */
	request(member: typeof ann | typeof ben, path: string, init: RequestInit = {}) {
		return fetch(`http://127.0.0.1:${this.port}${path}`, { ...init, headers: { [TAILSCALE_LOGIN_HEADER]: member.tailscaleLogin, "content-type": "application/json" } });
	}
	send(member: typeof ann | typeof ben, bot: string, text: string, requestId?: string) {
		return this.request(member, `/api/bots/${bot}/messages`, { method: "POST", body: JSON.stringify({ text, requestId }) });
	}
	async view(member: typeof ann | typeof ben, bot: string): Promise<View> {
		return (await this.request(member, `/api/bots/${bot}`)).json();
	}
	/** Waits until the Bot is idle with an assistant message last. */
	answered(member: typeof ann | typeof ben, bot: string, timeoutMs = 20_000) {
		return eventually(async () => {
			const v = await this.view(member, bot);
			return !v.busy && v.messages.at(-1)?.role === "assistant" ? v : undefined;
		}, "the Bot to answer", timeoutMs);
	}
	/** Waits for the scripted step that dropped this marker. */
	reached = (name: string) => eventually(() => existsSync(join(this.control, `reached-${name}`)) || undefined, `the model request "${name}"`);
}

/** Starts and tracks server processes, and kills any left over at the end of a test. */
export class Crashes {
	readonly #children: ChildProcess[] = [];
	#dirs: string[] = [];

	/** A data folder and a control folder for one test. */
	async folders(dataDir?: string) {
		const control = await mkdtemp(join(tmpdir(), "hamkey-control-"));
		this.#dirs.push(control);
		if (dataDir === undefined) {
			dataDir = await newDataDir();
			this.#dirs.push(dataDir);
		}
		return { dataDir, control };
	}

	/** Starts a server on the folders and waits until it listens. `script` is what the model says, request by request. */
	async start(folders: { dataDir: string; control: string }, script: Step[], more: Partial<Pick<ServerConfig, "extraBots" | "restartLimit">> = {}): Promise<Server> {
		await mkdir(folders.control, { recursive: true });
		const file = join(folders.control, `config-${this.#children.length}.json`);
		await writeFile(file, JSON.stringify({ ...folders, script, ...more } satisfies ServerConfig));
		// Node runs the fixture itself (with tsx loaded): the `tsx` command would start a second process, and killing its PID would leave the server running.
		const child = spawn(process.execPath, ["--import", "tsx", FIXTURE, file], { stdio: ["ignore", "pipe", "pipe"], cwd: ROOT });
		this.#children.push(child);
		let output = "";
		child.stderr!.on("data", (d) => (output += d));
		const port = await new Promise<number>((resolve, reject) => {
			child.stdout!.on("data", (d) => {
				output += d;
				const m = /LISTENING (\d+)/.exec(output);
				if (m) resolve(Number(m[1]));
			});
			child.once("exit", () => reject(new Error(`The server exited before listening:\n${output}`)));
		});
		return new Server(child, port, folders.control);
	}

	/** Every prompt the model was shown so far, oldest first, across all processes on this control folder. */
	async prompts(control: string): Promise<string[]> {
		const raw = await readFile(join(control, "prompts.jsonl"), "utf8").catch(() => "");
		return raw.split("\n").filter((l) => l !== "");
	}

	/** Kills the children this object started (by PID, never by pattern) and removes its folders. */
	async cleanup() {
		for (const child of this.#children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await Promise.all(this.#dirs.map((d) => rm(d, { recursive: true, force: true })));
		this.#children.length = 0;
		this.#dirs = [];
	}
}

/** How many lines a test tool has recorded: how often it really ran. */
export async function runs(control: string, tool: string): Promise<number> {
	return (await readFile(join(control, `effects-${tool}.log`), "utf8").catch(() => "")).split("\n").filter((l) => l !== "").length;
}

export const release = (control: string) => writeFile(join(control, "release"), "");
