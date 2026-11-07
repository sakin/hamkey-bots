import type { Bot } from "../bots.ts";
import type { Scope } from "./memory.ts";

export const BOT_TOOLS = ["memory_save", "memory_search", "memory_forget", "learned_update"] as const;
export type BotToolName = (typeof BOT_TOOLS)[number];

/** What a Bot may do with memory in one conversation. Built on the server from the Bot and Member, never from the model. */
export type MemoryAccess = {
	/** Scopes the Bot reads and searches, and may forget facts in. */
	read: Scope[];
	/** The one scope `memory_save` writes to. */
	write: Scope;
	tools: readonly string[];
};

/**
 * The scopes a Bot reaches for the Member whose conversation it is. A Personal Bot reads its Member's personal memory
 * and the household's. A Household Bot reads the household's alone. A Common Bot has one definition but serves each
 * Member separately, so it reads only its own notes for that Member.
 */
export function accessFor(bot: Bot, memberId: string | undefined): MemoryAccess | undefined {
	const tools = bot.tools ?? [...BOT_TOOLS];
	switch (bot.kind) {
		case "household":
			return {
				read: [{ kind: "household" }, { kind: "bot", bot: bot.id }],
				write: { kind: "household" },
				tools,
			};
		case "personal": {
			if (memberId === undefined || memberId !== bot.owner) return undefined;
			return {
				read: [{ kind: "member", member: memberId }, { kind: "household" }, { kind: "bot", bot: bot.id }],
				write: { kind: "member", member: memberId },
				tools,
			};
		}
		case "common": {
			if (memberId === undefined) return undefined;
			const own: Scope = { kind: "bot", bot: bot.id, member: memberId };
			return { read: [own], write: own, tools };
		}
	}
}
