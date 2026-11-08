import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ApprovalFields, type CardType, type ChoiceFields, InvalidCard, type QuestionFields, validateFields } from "./cards.ts";

/**
 * waiting: nobody has acted. approved / rejected: an Approval Card's outcome. chosen: a Choice Card was answered.
 * answered: a direct question's Member wrote in the thread. A Card never leaves a settled status, so a second tap
 * changes nothing.
 */
export type CardStatus = "waiting" | "approved" | "rejected" | "chosen" | "answered";

export type Card = {
	id: string;
	type: CardType;
	/** The conversation the Card appears in. Never shown to clients. */
	thread: string;
	botId: string;
	/** The Members who may act on it: the Fact's owner for an Approval, the thread's Members for a Choice. */
	addressees: string[];
	fields: ApprovalFields | ChoiceFields | QuestionFields;
	status: CardStatus;
	createdAt: string;
	resolvedAt?: string;
	resolvedBy?: string;
	/** Index of the option picked on a Choice Card. */
	choice?: number;
};

/** Most Cards that may wait for one Member, so a Bot cannot bury the Member in them. */
export const MAX_WAITING = 20;

/**
 * Cards kept in `<dataDir>/cards.json`. Cards are Hamkey records addressed to Members across threads (badges and push
 * need "what waits for Member M"), which a conversation's own documents cannot answer, so they live beside the other
 * file stores (ADR 0008).
 */
export class CardStore {
	readonly #file: string;
	#loading: Promise<Card[]> | undefined;
	#writes: Promise<unknown> = Promise.resolve();
	readonly #listeners = new Set<(card: Card) => void>();

	constructor(dataDir: string) {
		this.#file = join(dataDir, "cards.json");
	}

	#load(): Promise<Card[]> {
		this.#loading ??= readFile(this.#file, "utf8").then(
			(raw) => JSON.parse(raw) as Card[],
			(error) => {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
				throw error;
			},
		);
		this.#loading.catch(() => (this.#loading = undefined));
		return this.#loading;
	}

	/** Runs one change at a time and writes the file before the change is visible to callers. */
	#change<T>(change: (cards: Card[]) => T): Promise<T> {
		const run = this.#writes.then(async () => {
			const cards = await this.#load();
			const next = [...cards];
			const result = change(next);
			if (next.length === cards.length && next.every((c, i) => c === cards[i])) return result;
			await mkdir(join(this.#file, ".."), { recursive: true });
			await writeFile(`${this.#file}.tmp`, JSON.stringify(next, null, 2));
			await rename(`${this.#file}.tmp`, this.#file);
			this.#loading = Promise.resolve(next);
			return result;
		});
		this.#writes = run.catch(() => {});
		return run;
	}

	/**
	 * Validates against the catalog and stores a waiting Card. Throws `InvalidCard` if the fields are not allowed or the
	 * Member has too many waiting. The same `id` returns the Card already made, so a rerun after a crash adds nothing.
	 */
	async create(input: { id: string; type: CardType; thread: string; botId: string; addressees: string[]; fields: unknown }): Promise<Card> {
		const fields = validateFields(input.type, input.fields);
		if (input.addressees.length === 0) throw new InvalidCard("A Card needs someone to answer it.");
		const card = await this.#change((cards) => {
			const existing = cards.find((c) => c.id === input.id);
			if (existing !== undefined) return existing;
			for (const member of input.addressees) {
				if (cards.filter((c) => c.status === "waiting" && c.addressees.includes(member)).length >= MAX_WAITING) {
					throw new InvalidCard("Too many Cards are already waiting for an answer. Wait for the Member to deal with them.");
				}
			}
			const made: Card = {
				id: input.id,
				type: input.type,
				thread: input.thread,
				botId: input.botId,
				addressees: [...input.addressees],
				fields,
				status: "waiting",
				createdAt: new Date().toISOString(),
			};
			cards.push(made);
			return made;
		});
		this.#notify(card);
		return card;
	}

	async get(id: string): Promise<Card | undefined> {
		return (await this.#load()).find((c) => c.id === id);
	}

	/** Cards waiting for this Member to act, oldest first. This is what badges and push count. */
	async waitingFor(memberId: string): Promise<Card[]> {
		await this.#writes;
		return (await this.#load()).filter((c) => c.status === "waiting" && c.addressees.includes(memberId));
	}

	/** The Cards of one thread that this Member may see, oldest first, settled ones included. Thread ids are compared as text because the thread index holds them as numbers. */
	async inThread(thread: string, memberId: string): Promise<Card[]> {
		await this.#writes;
		return (await this.#load()).filter((c) => c.thread === String(thread) && c.addressees.includes(memberId));
	}

	/**
	 * Settles a waiting Card for `by`. Returns the settled Card, or undefined if it was no longer waiting (someone else got
	 * there first), so two taps cannot both win.
	 */
	async settle(id: string, status: Exclude<CardStatus, "waiting">, by: string, extra: { choice?: number } = {}): Promise<Card | undefined> {
		const settled = await this.#change((cards) => {
			const i = cards.findIndex((c) => c.id === id);
			if (i === -1 || cards[i]!.status !== "waiting") return undefined;
			return (cards[i] = { ...cards[i]!, status, resolvedBy: by, resolvedAt: new Date().toISOString(), ...extra });
		});
		if (settled !== undefined) this.#notify(settled);
		return settled;
	}

	/**
	 * Settles the direct questions waiting for `memberId` in `thread`: they have now written there, which is the answer.
	 * Cards of other Members, other threads and other types are left alone.
	 */
	async answerQuestions(thread: string, memberId: string): Promise<Card[]> {
		const answered = await this.#change((cards) => {
			const done: Card[] = [];
			cards.forEach((c, i) => {
				if (c.type !== "question" || c.status !== "waiting" || c.thread !== String(thread) || !c.addressees.includes(memberId)) return;
				done.push((cards[i] = { ...c, status: "answered", resolvedBy: memberId, resolvedAt: new Date().toISOString() }));
			});
			return done;
		});
		for (const card of answered) this.#notify(card);
		return answered;
	}

	/** Calls `listener` after any Card is made or settled. Returns an unsubscribe function. */
	subscribe(listener: (card: Card) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#notify(card: Card) {
		for (const listener of this.#listeners) listener(card);
	}
}
