import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatEngine, ThreadId } from "./chat/engine.ts";
import type { Member } from "./members.ts";
import { Bots, type Bot } from "./bots.ts";

/**
 * Maps each Member and Bot to a main thread. Thread access lives here so every read and write passes through one
 * ownership check (ADR 0005). Callers name a Bot, never a thread, so a guessed ID reaches nothing.
 *
 * Whose thread it is follows the Bot's kind: a personal or common Bot's thread belongs to one Member, and a household
 * Bot has one thread that both Members share.
 */
export class Threads {
	readonly #file: string;
	readonly #engine: ChatEngine;
	#loading: Promise<Record<string, ThreadId>> | undefined;
	#pending = new Map<string, Promise<ThreadId>>();
	/** Index writes run one at a time, so two Members' first use cannot trample the same temporary file. */
	#writes: Promise<unknown> = Promise.resolve();

	readonly #bots: Bots;

	constructor(dataDir: string, engine: ChatEngine, bots: Bots) {
		this.#bots = bots;
		this.#file = join(dataDir, "threads.json");
		this.#engine = engine;
	}

	/** The Member's Bots. */
	botsFor(member: Member): Bot[] {
		return this.#bots.listFor(member);
	}

	/** The Bot and the main thread this Member may use with it (created on first use), or undefined if they may not. */
	async mainThread(member: Member, botId: string): Promise<{ bot: Bot; thread: ThreadId } | undefined> {
		const bot = this.#bots.find(member, botId);
		if (bot === undefined) return undefined;
		const key = `${bot.id}:${bot.kind === "household" ? "household" : member.id}`;
		let pending = this.#pending.get(key);
		if (pending === undefined) {
			pending = this.#resolve(key, bot);
			this.#pending.set(key, pending);
			// A failure must not stick: forget it so the next request tries again.
			pending.catch(() => {
				if (this.#pending.get(key) === pending) this.#pending.delete(key);
			});
		}
		return { bot, thread: await pending };
	}

	async #resolve(key: string, bot: Bot): Promise<ThreadId> {
		const index = await this.#load();
		const existing = index[key];
		if (existing !== undefined) return existing;
		const id = await this.#engine.createThread({ instructions: bot.instructions });
		index[key] = id;
		try {
			await this.#save(index);
		} catch (error) {
			delete index[key];
			throw error;
		}
		return id;
	}

	/** Writes the index as it stands when this write's turn comes, so one Member's entry is never lost to another's write. */
	#save(index: Record<string, ThreadId>): Promise<void> {
		const write = this.#writes.then(async () => {
			await mkdir(join(this.#file, ".."), { recursive: true });
			await writeFile(`${this.#file}.tmp`, JSON.stringify(index, null, 2));
			await rename(`${this.#file}.tmp`, this.#file);
		});
		this.#writes = write.catch(() => {});
		return write;
	}

	/** Loaded once; concurrent first calls share one load so they all work on the same index object. */
	#load(): Promise<Record<string, ThreadId>> {
		this.#loading ??= (async () => {
			try {
				return JSON.parse(await readFile(this.#file, "utf8")) as Record<string, ThreadId>;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				return {};
			}
		})();
		this.#loading.catch(() => (this.#loading = undefined));
		return this.#loading;
	}
}
