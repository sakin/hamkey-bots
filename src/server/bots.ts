import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Member } from "./members.ts";
import { accessFor, type MemoryAccess, BOT_TOOLS } from "./memory/access.ts";
import { primaryBotFor } from "./primary-bot.ts";

export type BotKind = "personal" | "household" | "common";

/** One Bot definition, as written in a file in the `bots` folder of the data folder. */
export type Bot = {
	id: string;
	name: string;
	kind: BotKind;
	/** Member id; required for personal Bots and absent otherwise. */
	owner?: string;
	instructions: string;
	/** An OpenRouter model id. Absent means the server's default model. */
	model?: string;
	/** Names of the tools this Bot may use. Absent means every memory tool. */
	tools?: string[];
};

export type BotSummary = Pick<Bot, "id" | "name" | "kind">;

const KINDS: readonly string[] = ["personal", "household", "common"];
const ID = /^[a-z0-9][a-z0-9-]*$/;

/** What a Member may set when creating or editing a Bot. The id, kind and owner are not theirs to change. */
export type BotInput = { name: string; instructions: string; model?: string; tools?: string[] };

/** Reads every `*.json` Bot in `<dataDir>/bots`; files that are not valid Bots are reported, not thrown. */
async function readBots(dataDir: string, members: readonly Member[]): Promise<{ bots: Bot[]; errors: Map<string, Error> }> {
	const dir = join(dataDir, "bots");
	let files: string[];
	try {
		files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bots: [], errors: new Map() };
		throw error;
	}
	const bots: Bot[] = [];
	const errors = new Map<string, Error>();
	for (const file of files) {
		try {
			let raw: unknown;
			try {
				raw = JSON.parse(await readFile(join(dir, file), "utf8"));
			} catch (error) {
				throw new Error(`Bot file ${file} is not valid JSON: ${(error as Error).message}`);
			}
			bots.push(validate(raw, file, members));
		} catch (error) {
			errors.set(file.replace(/\.json$/, ""), error as Error);
		}
	}
	return { bots, errors };
}

/** Reads every Bot at startup. A missing folder means no Bots beyond the Primary Bots; a bad file stops the server. */
export async function loadBots(dataDir: string, members: readonly Member[]): Promise<Bot[]> {
	const { bots, errors } = await readBots(dataDir, members);
	for (const error of errors.values()) throw error;
	return bots;
}

/** What is wrong with the fields a Member may set, or undefined. */
export function checkInput(b: Partial<BotInput>): string | undefined {
	if (typeof b.name !== "string" || b.name.trim() === "") return "name is required";
	if (b.name.length > 80) return "name is too long";
	if (typeof b.instructions !== "string" || b.instructions.trim() === "") return "instructions are required";
	if (b.instructions.length > 20_000) return "instructions are too long";
	if (b.model !== undefined && (typeof b.model !== "string" || b.model === "" || b.model.length > 200)) return "model must be a model id";
	if (b.tools !== undefined) {
		const known: readonly string[] = BOT_TOOLS;
		if (!Array.isArray(b.tools) || !b.tools.every((t) => typeof t === "string" && known.includes(t))) {
			return `tools must be a list drawn from ${BOT_TOOLS.join(", ")}`;
		}
	}
	return undefined;
}

function validate(raw: unknown, file: string, members: readonly Member[]): Bot {
	const b = raw as Partial<Bot> | null;
	const fail = (why: string): never => {
		throw new Error(`Bot file ${file}: ${why}`);
	};
	if (b === null || typeof b !== "object") return fail("expected an object");
	if (typeof b.id !== "string" || !ID.test(b.id)) return fail("id must be lowercase letters, digits and dashes");
	if (b.id !== file.replace(/\.json$/, "")) return fail("id must match the file name");
	const problem = checkInput(b);
	if (problem !== undefined) return fail(problem);
	if (typeof b.kind !== "string" || !KINDS.includes(b.kind)) return fail(`kind must be one of ${KINDS.join(", ")}`);
	if (b.kind === "personal") {
		if (!members.some((m) => m.id === b.owner)) return fail("a personal Bot needs an owner who is a Member");
	} else if (b.owner !== undefined) {
		return fail(`a ${b.kind} Bot has no owner`);
	}
	return { id: b.id, name: b.name!, kind: b.kind as BotKind, owner: b.owner, instructions: b.instructions!, model: b.model, tools: b.tools };
}

/** Every Bot a Member may use, and the one rule for who may use what. Bots can be created and edited while running. */
export class Bots {
	#bots: readonly Bot[];
	readonly #primary: readonly Bot[];
	readonly #members: readonly Member[];
	readonly #dataDir: string | undefined;
	/** File writes run one at a time, so two creates cannot choose the same id. */
	#writes: Promise<unknown> = Promise.resolve();

	constructor(bots: readonly Bot[], members: readonly Member[], dataDir?: string) {
		this.#primary = members.map(primaryBotFor);
		this.#members = members;
		this.#dataDir = dataDir;
		this.#bots = Bots.#join(this.#primary, bots);
	}

	static #join(primary: readonly Bot[], bots: readonly Bot[]): Bot[] {
		const all = [...primary, ...bots];
		const seen = new Set<string>();
		for (const bot of all) {
			if (seen.has(bot.id)) throw new Error(`Two Bots share the id "${bot.id}".`);
			seen.add(bot.id);
		}
		return all;
	}

	static mayUse(member: Member, bot: Bot): boolean {
		return bot.kind !== "personal" || bot.owner === member.id;
	}

	/** Whether a Member may edit this Bot: they may use it, and it is not a Primary Bot, which is built in. */
	isEditable(bot: Bot): boolean {
		return !this.#primary.some((p) => p.id === bot.id);
	}

	/**
	 * Picks up hand edits to the Bot files. A file that is no longer valid keeps its last good definition and is logged,
	 * so a typo cannot take a Bot away mid-conversation.
	 */
	async reload(): Promise<void> {
		if (this.#dataDir === undefined) return;
		await this.#writes;
		await this.#refresh();
	}

	/** Creates a Bot owned by the Member (if personal) and writes its file. It can be used straight away. */
	create(member: Member, kind: BotKind, input: BotInput): Promise<Bot> {
		if (!KINDS.includes(kind)) return Promise.reject(new InvalidBot(`kind must be one of ${KINDS.join(", ")}`));
		const problem = checkInput(input);
		if (problem !== undefined) return Promise.reject(new InvalidBot(problem));
		return this.#write(async () => {
			const taken = new Set(this.#bots.map((b) => b.id));
			const base = input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "bot";
			let id = base;
			for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
			const bot: Bot = {
				id,
				name: input.name.trim(),
				kind,
				owner: kind === "personal" ? member.id : undefined,
				instructions: input.instructions,
				model: input.model,
				tools: input.tools,
			};
			await this.#save(bot);
			this.#bots = [...this.#bots, bot];
			return bot;
		});
	}

	/** Changes the fields a Member may set. The id, kind and owner stay as they were. */
	update(member: Member, id: string, input: BotInput): Promise<Bot | undefined> {
		const problem = checkInput(input);
		if (problem !== undefined) return Promise.reject(new InvalidBot(problem));
		return this.#write(async () => {
			const current = this.find(member, id);
			if (current === undefined) return undefined;
			if (!this.isEditable(current)) throw new InvalidBot("A Primary Bot is built in and cannot be edited.");
			const bot: Bot = { ...current, name: input.name.trim(), instructions: input.instructions, model: input.model, tools: input.tools };
			await this.#save(bot);
			this.#bots = this.#bots.map((b) => (b.id === id ? bot : b));
			return bot;
		});
	}

	#write<T>(work: () => Promise<T>): Promise<T> {
		if (this.#dataDir === undefined) return Promise.reject(new Error("Bots cannot be saved without a data folder."));
		const run = this.#writes.then(async () => {
			await this.#refresh();
			return work();
		});
		this.#writes = run.catch(() => {});
		return run;
	}

	async #refresh(): Promise<void> {
		const { bots, errors } = await readBots(this.#dataDir!, this.#members);
		for (const [id, error] of errors) {
			console.error(error.message);
			const previous = this.#bots.find((b) => b.id === id && !this.#primary.includes(b));
			if (previous !== undefined) bots.push(previous);
		}
		try {
			this.#bots = Bots.#join(this.#primary, bots);
		} catch (error) {
			console.error((error as Error).message);
		}
	}

	async #save(bot: Bot): Promise<void> {
		const dir = join(this.#dataDir!, "bots");
		await mkdir(dir, { recursive: true });
		const path = join(dir, `${bot.id}.json`);
		await writeFile(`${path}.tmp`, JSON.stringify(bot, null, "\t") + "\n");
		await rename(`${path}.tmp`, path);
	}

	/** What the Bot may do with memory in a conversation of this Member, or undefined if nothing. Reads the Bot as defined now. */
	memoryAccess(binding: { botId: string; memberId: string | null }): MemoryAccess | undefined {
		const bot = this.#bots.find((b) => b.id === binding.botId);
		return bot === undefined ? undefined : accessFor(bot, binding.memberId ?? undefined);
	}

	/** The Member's Bots, Primary Bot first. */
	listFor(member: Member): Bot[] {
		return this.#bots.filter((b) => Bots.mayUse(member, b));
	}

	/** The Bot, or undefined if it does not exist or the Member may not use it (the two look the same). */
	find(member: Member, id: string): Bot | undefined {
		const bot = this.#bots.find((b) => b.id === id);
		return bot !== undefined && Bots.mayUse(member, bot) ? bot : undefined;
	}
}

/** The Member's input was refused; the message says why and is safe to show them. */
export class InvalidBot extends Error {}
