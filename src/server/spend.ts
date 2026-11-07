import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** What a Member sees when model work is refused for the day. Plain words, safe to show as is. */
export const LIMIT_REACHED =
	"Hamkey has reached today's spending limit, so Bots cannot answer until tomorrow. The Operator can raise the limit.";

/** Where today began, as the running total stood then. Kept in `<dataDir>/spend.json`. */
type Ledger = { day: string; startTotal: number };

export type DailySpendOptions = {
	dataDir: string;
	/** Most US dollars the household may spend on models in one day. Zero refuses all model work. */
	limitUsd: number;
	/** The running total of everything ever spent, in US dollars. It only goes up while the store is kept. */
	total: () => Promise<number>;
	/** The clock; a day is the server's local calendar day. */
	now?: () => Date;
};

/** The server's local calendar date, as YYYY-MM-DD. */
function localDay(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The daily spend limit. Pi Durable keeps running totals, not daily figures, so Hamkey notes the total when each day
 * begins and takes today's spend as the difference. The note is a file, so a restart keeps it. The day begins at the
 * first check after midnight, and model work is checked before every request, so little can slip between.
 */
export class DailySpend {
	readonly limitUsd: number;
	readonly #file: string;
	readonly #total: () => Promise<number>;
	readonly #now: () => Date;
	#ledger: Ledger | undefined;
	/** Checks run one at a time, so two cannot both start a new day and write over each other. */
	#queue: Promise<unknown> = Promise.resolve();

	constructor(options: DailySpendOptions) {
		this.limitUsd = options.limitUsd;
		this.#file = join(options.dataDir, "spend.json");
		this.#total = options.total;
		this.#now = options.now ?? (() => new Date());
	}

	/** US dollars spent today. */
	today(): Promise<number> {
		const run = this.#queue.then(() => this.#today());
		this.#queue = run.catch(() => {});
		return run;
	}

	/** Why model work must be refused now, or undefined when it may go ahead. */
	async refusal(): Promise<string | undefined> {
		return (await this.today()) >= this.limitUsd ? LIMIT_REACHED : undefined;
	}

	async #today(): Promise<number> {
		const total = await this.#total();
		const day = localDay(this.#now());
		const ledger = (this.#ledger ??= await this.#read());
		// A new day, a first run, or a store whose totals started again: today starts from the total as it is now.
		if (ledger === undefined || ledger.day !== day || total < ledger.startTotal) {
			this.#ledger = { day, startTotal: total };
			await this.#write(this.#ledger);
			return 0;
		}
		return total - ledger.startTotal;
	}

	async #read(): Promise<Ledger | undefined> {
		try {
			const ledger = JSON.parse(await readFile(this.#file, "utf8")) as Partial<Ledger>;
			if (typeof ledger.day !== "string" || typeof ledger.startTotal !== "number") return undefined;
			return { day: ledger.day, startTotal: ledger.startTotal };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
			throw error;
		}
	}

	async #write(ledger: Ledger): Promise<void> {
		await mkdir(join(this.#file, ".."), { recursive: true });
		await writeFile(`${this.#file}.tmp`, JSON.stringify(ledger, null, 2) + "\n");
		await rename(`${this.#file}.tmp`, this.#file);
	}
}
