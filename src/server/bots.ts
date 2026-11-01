import { readdir, readFile } from "node:fs/promises";
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
	/** Names of the tools this Bot may use. Absent means every memory tool. */
	tools?: string[];
};

export type BotSummary = Pick<Bot, "id" | "name" | "kind">;

const KINDS: readonly string[] = ["personal", "household", "common"];
const ID = /^[a-z0-9][a-z0-9-]*$/;

/** Reads every `*.json` Bot in `<dataDir>/bots`. A missing folder means no Bots beyond the Primary Bots. */
export async function loadBots(dataDir: string, members: readonly Member[]): Promise<Bot[]> {
	const dir = join(dataDir, "bots");
	let files: string[];
	try {
		files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const bots: Bot[] = [];
	for (const file of files) {
		let raw: unknown;
		try {
			raw = JSON.parse(await readFile(join(dir, file), "utf8"));
		} catch (error) {
			throw new Error(`Bot file ${file} is not valid JSON: ${(error as Error).message}`);
		}
		bots.push(validate(raw, file, members));
	}
	return bots;
}

function validate(raw: unknown, file: string, members: readonly Member[]): Bot {
	const b = raw as Partial<Bot> | null;
	const fail = (why: string): never => {
		throw new Error(`Bot file ${file}: ${why}`);
	};
	if (b === null || typeof b !== "object") return fail("expected an object");
	if (typeof b.id !== "string" || !ID.test(b.id)) return fail("id must be lowercase letters, digits and dashes");
	if (b.id !== file.replace(/\.json$/, "")) return fail("id must match the file name");
	if (typeof b.name !== "string" || b.name === "") return fail("name is required");
	if (typeof b.instructions !== "string" || b.instructions === "") return fail("instructions are required");
	if (typeof b.kind !== "string" || !KINDS.includes(b.kind)) return fail(`kind must be one of ${KINDS.join(", ")}`);
	if (b.kind === "personal") {
		if (!members.some((m) => m.id === b.owner)) return fail("a personal Bot needs an owner who is a Member");
	} else if (b.owner !== undefined) {
		return fail(`a ${b.kind} Bot has no owner`);
	}
	if (b.tools !== undefined) {
		const known: readonly string[] = BOT_TOOLS;
		if (!Array.isArray(b.tools) || !b.tools.every((t) => typeof t === "string" && known.includes(t))) {
			return fail(`tools must be a list drawn from ${BOT_TOOLS.join(", ")}`);
		}
	}
	return { id: b.id, name: b.name, kind: b.kind as BotKind, owner: b.owner, instructions: b.instructions, tools: b.tools };
}

/** Every Bot a Member may use, and the one rule for who may use what. */
export class Bots {
	readonly #bots: readonly Bot[];

	constructor(bots: readonly Bot[], members: readonly Member[]) {
		const all = [...members.map(primaryBotFor), ...bots];
		const seen = new Set<string>();
		for (const bot of all) {
			if (seen.has(bot.id)) throw new Error(`Two Bots share the id "${bot.id}".`);
			seen.add(bot.id);
		}
		this.#bots = all;
	}

	static mayUse(member: Member, bot: Bot): boolean {
		return bot.kind !== "personal" || bot.owner === member.id;
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
