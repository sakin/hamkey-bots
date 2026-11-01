import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatEngine, ThreadId } from "./chat/engine.ts";
import type { Member } from "./members.ts";
import { primaryBotFor } from "./primary-bot.ts";

/**
 * Maps each Member to their Primary Bot's main thread. Thread access lives here so every read and write passes through
 * one ownership check (ADR 0005); later tickets extend it to other kinds of thread.
 */
export class Threads {
	readonly #file: string;
	readonly #engine: ChatEngine;
	#loading: Promise<Record<string, ThreadId>> | undefined;
	#pending = new Map<string, Promise<ThreadId>>();
	/** Index writes run one at a time, so two Members' first use cannot trample the same temporary file. */
	#writes: Promise<unknown> = Promise.resolve();

	constructor(dataDir: string, engine: ChatEngine) {
		this.#file = join(dataDir, "threads.json");
		this.#engine = engine;
	}

	/** The thread a Member may use with their Primary Bot, created on first use. */
	primaryThreadFor(member: Member): Promise<ThreadId> {
		let pending = this.#pending.get(member.id);
		if (pending === undefined) {
			pending = this.#resolve(member);
			this.#pending.set(member.id, pending);
			// A failure must not stick: forget it so the next request tries again.
			pending.catch(() => {
				if (this.#pending.get(member.id) === pending) this.#pending.delete(member.id);
			});
		}
		return pending;
	}

	async #resolve(member: Member): Promise<ThreadId> {
		const index = await this.#load();
		const key = `primary:${member.id}`;
		const existing = index[key];
		if (existing !== undefined) return existing;
		const id = await this.#engine.createThread({ instructions: primaryBotFor(member).instructions });
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
