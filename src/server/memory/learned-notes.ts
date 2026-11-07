import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Most characters a Bot's notes may hold, so they cannot grow until they crowd out the conversation. */
export const LEARNED_CAP = 4000;

/**
 * Each Bot's `learned.md`: habits it has worked out and may rewrite freely. It lives next to the Bot's definition as
 * `<dataDir>/bots/<bot>.learned.md`. This is the only part of a Bot that the Bot itself changes (everything else changes
 * only when a Member changes it), and a caller names a Bot only by id, from the server's own binding.
 */
export class LearnedNotes {
	readonly #dir: string;
	#writes: Promise<unknown> = Promise.resolve();

	constructor(dataDir: string) {
		this.#dir = join(dataDir, "bots");
	}

	#path(botId: string): string {
		return join(this.#dir, `${encodeURIComponent(botId)}.learned.md`);
	}

	async read(botId: string): Promise<string> {
		try {
			return await readFile(this.#path(botId), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
			throw error;
		}
	}

	/** Replaces the notes. Over the cap is refused, leaving the old notes in place. */
	write(botId: string, notes: string): Promise<void> {
		if (notes.length > LEARNED_CAP) {
			return Promise.reject(new Error(`Notes are ${notes.length} characters; the limit is ${LEARNED_CAP}. Shorten them.`));
		}
		const write = this.#writes.then(async () => {
			await mkdir(this.#dir, { recursive: true });
			const path = this.#path(botId);
			await writeFile(`${path}.tmp`, notes);
			await rename(`${path}.tmp`, path);
		});
		this.#writes = write.catch(() => {});
		return write;
	}
}
