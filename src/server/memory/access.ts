import type { Bot } from "../bots.ts";
import { RESEARCH_BOT_ID, WEB_TOOLS } from "../research-bot.ts";
import type { Scope } from "./memory.ts";

export const BOT_TOOLS = ["memory_save", "memory_search", "memory_forget", "learned_update", "research"] as const;
/** What a Bot has when it names no tools: memory only. Research is something a Member ticks (ADR 0004). */
export const DEFAULT_TOOLS: readonly string[] = ["memory_save", "memory_search", "memory_forget", "learned_update"];
export type BotToolName = (typeof BOT_TOOLS)[number];

/** What a Bot may do with memory in one conversation. Built on the server from the Bot and Member, never from the model. */
export type MemoryAccess = {
	/** Scopes the Bot reads and searches, and may forget facts in. */
	read: Scope[];
	/** The one scope `memory_save` writes to; absent when the Bot has no memory at all. */
	write?: Scope;
	/** Whether the Bot sees and may rewrite its learned notes. */
	notes: boolean;
	tools: readonly string[];
};

/**
 * The scopes a Bot reaches for the Member whose conversation it is. A Personal Bot reads its Member's personal memory
 * and the household's. A Household Bot reads the household's alone. A Common Bot has one definition but serves each
 * Member separately, so it reads only its own notes for that Member.
 */
export function accessFor(bot: Bot, memberId: string | undefined): MemoryAccess | undefined {
	// The Research Bot reads web pages written by strangers, so it gets the web tools and no memory, and never the
	// research tool, so it cannot call itself or other Bots (ADR 0004). Its conversations belong to no Member when a
	// Household Bot asked, so this does not depend on `memberId`.
	if (bot.id === RESEARCH_BOT_ID) return { read: [], notes: false, tools: [...WEB_TOOLS] };
	const tools = bot.tools ?? [...DEFAULT_TOOLS];
	switch (bot.kind) {
		case "household":
			return {
				read: [{ kind: "household" }, { kind: "bot", bot: bot.id }],
				write: { kind: "household" },
				notes: true,
				tools,
			};
		case "personal": {
			if (memberId === undefined || memberId !== bot.owner) return undefined;
			return {
				read: [{ kind: "member", member: memberId }, { kind: "household" }, { kind: "bot", bot: bot.id }],
				write: { kind: "member", member: memberId },
				notes: true,
				tools,
			};
		}
		case "common": {
			if (memberId === undefined) return undefined;
			const own: Scope = { kind: "bot", bot: bot.id, member: memberId };
			return { read: [own], write: own, notes: true, tools };
		}
	}
}
