import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AskRecord } from "./chat/ask-tool.ts";

/** One Ask as kept: what a Bot sent, what came back or why nothing did. */
export type AskEntry = {
	/** The id of the `ask` call, so a rerun after a crash is the same entry. */
	id: string;
	time: string;
	askerBotId: string;
	/** The Bot's name when it asked, kept so the entry still reads right if the Bot is renamed or removed. */
	askerBotName: string;
	/** The Member whose private thread the Bot asked from, or null in a shared thread. */
	askerMemberId: string | null;
	/** Absent when the Member asked about does not exist. */
	targetMemberId?: string;
	topic: string;
	question: string;
	outcome: AskRecord["outcome"];
	reason?: string;
	answer?: string;
};

const MAX_TOPIC = 80;

/**
 * Every Ask and its outcome, in `<dataDir>/asks.json`. Sharing is meant to be transparent: both Members read the whole log,
 * refused Asks included. Entries are kept by id and never changed, so recording the same Ask twice (a rerun after a
 * restart) leaves one entry, with the time of the first.
 */
export class AskLog {
	readonly #file: string;
	readonly #botName: (botId: string) => string | undefined;
	#loading: Promise<AskEntry[]> | undefined;
	#writes: Promise<unknown> = Promise.resolve();

	constructor(dataDir: string, botName: (botId: string) => string | undefined) {
		this.#file = join(dataDir, "asks.json");
		this.#botName = botName;
	}

	#load(): Promise<AskEntry[]> {
		this.#loading ??= readFile(this.#file, "utf8").then(
			(raw) => JSON.parse(raw) as AskEntry[],
			(error) => {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
				throw error;
			},
		);
		this.#loading.catch(() => (this.#loading = undefined));
		return this.#loading;
	}

	/** Adds the Ask unless its id is already logged. Writes the file before returning. */
	record(ask: AskRecord): Promise<void> {
		const run = this.#writes.then(async () => {
			const entries = await this.#load();
			if (entries.some((e) => e.id === ask.id)) return;
			const entry: AskEntry = {
				id: ask.id,
				time: new Date().toISOString(),
				askerBotId: ask.askerBotId,
				askerBotName: this.#botName(ask.askerBotId) ?? ask.askerBotId,
				askerMemberId: ask.askerMemberId,
				targetMemberId: ask.targetMemberId,
				topic: ask.topic.slice(0, MAX_TOPIC),
				question: ask.question,
				outcome: ask.outcome,
				reason: ask.reason,
				answer: ask.answer,
			};
			const next = [...entries, entry];
			await mkdir(join(this.#file, ".."), { recursive: true });
			await writeFile(`${this.#file}.tmp`, JSON.stringify(next, null, 2));
			await rename(`${this.#file}.tmp`, this.#file);
			this.#loading = Promise.resolve(next);
		});
		this.#writes = run.catch(() => {});
		return run;
	}

	/** Every entry, newest first. */
	async all(): Promise<AskEntry[]> {
		await this.#writes;
		return [...(await this.#load())].reverse();
	}
}
