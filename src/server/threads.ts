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
	#index: Record<string, ThreadId> | undefined;
	#pending = new Map<string, Promise<ThreadId>>();

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
		await mkdir(join(this.#file, ".."), { recursive: true });
		await writeFile(`${this.#file}.tmp`, JSON.stringify(index, null, 2));
		await rename(`${this.#file}.tmp`, this.#file);
		return id;
	}

	async #load(): Promise<Record<string, ThreadId>> {
		if (this.#index !== undefined) return this.#index;
		try {
			this.#index = JSON.parse(await readFile(this.#file, "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			this.#index = {};
		}
		return this.#index!;
	}
}
