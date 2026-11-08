import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isTopic, TOPICS, type TopicId } from "./memory/topics.ts";

/** For each Topic, the ids of the Bots a Member lets Ask about it. A Topic that is missing, or has no Bots, is exposed to nobody. */
export type ExposureList = Record<TopicId, string[]>;

export const emptyExposure = (): ExposureList => Object.fromEntries(TOPICS.map((t) => [t.id, [] as string[]])) as ExposureList;

/** The Member's input was refused; the message says why and is safe to show them. */
export class InvalidExposure extends Error {}

/**
 * Each Member's Exposure List, kept in `<dataDir>/exposure/<member>.json`. It is read from the file on every call and
 * never cached, so a change applies to the very next Ask without a restart (ADR 0003). Anything unreadable or unexpected
 * counts as "nothing exposed": a damaged file can only close a door, never open one.
 */
export class Exposure {
	readonly #dir: string;
	/** Writes run one at a time so two saves cannot trample the same temporary file. */
	#writes: Promise<unknown> = Promise.resolve();

	constructor(dataDir: string) {
		this.#dir = join(dataDir, "exposure");
	}

	/** The Member's list. Only Topics Hamkey knows are read, so a hand-edited file cannot invent one. */
	async get(memberId: string): Promise<ExposureList> {
		const list = emptyExposure();
		let raw: unknown;
		try {
			raw = JSON.parse(await readFile(join(this.#dir, `${memberId}.json`), "utf8"));
		} catch {
			return list;
		}
		if (raw === null || typeof raw !== "object") return list;
		for (const topic of TOPICS) {
			const ids = (raw as Record<string, unknown>)[topic.id];
			if (Array.isArray(ids)) list[topic.id] = ids.filter((id): id is string => typeof id === "string");
		}
		return list;
	}

	/** Whether this Member's list lets the Bot Ask about the Topic. Reads the file now. */
	async allows(memberId: string, topic: string, botId: string): Promise<boolean> {
		return isTopic(topic) && (await this.get(memberId))[topic].includes(botId);
	}

	/**
	 * Replaces the Member's list. `candidates` are the Bot ids that may be listed at all; an unknown Topic or Bot is
	 * refused rather than dropped, so a typo cannot silently leave something unexposed or exposed.
	 */
	async set(memberId: string, wanted: unknown, candidates: readonly string[]): Promise<ExposureList> {
		if (wanted === null || typeof wanted !== "object" || Array.isArray(wanted)) throw new InvalidExposure("The exposure list must be an object of Topics.");
		const list = emptyExposure();
		for (const [topic, ids] of Object.entries(wanted)) {
			if (!isTopic(topic)) throw new InvalidExposure(`Unknown Topic "${topic}".`);
			if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) throw new InvalidExposure("Each Topic needs a list of Bot ids.");
			for (const id of ids as string[]) if (!candidates.includes(id)) throw new InvalidExposure(`"${id}" is not a Bot that can be listed.`);
			list[topic] = [...new Set(ids as string[])];
		}
		const run = this.#writes.then(async () => {
			await mkdir(this.#dir, { recursive: true });
			const path = join(this.#dir, `${memberId}.json`);
			await writeFile(`${path}.tmp`, JSON.stringify(list, null, "\t") + "\n");
			await rename(`${path}.tmp`, path);
		});
		this.#writes = run.catch(() => {});
		await run;
		return list;
	}
}
