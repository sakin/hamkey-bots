import type { Member } from "./members.ts";

export type BotDefinition = { name: string; instructions: string };

/** Every Member has exactly one Primary Bot. Editable definitions arrive with the Bot registry. */
export function primaryBotFor(member: Member): BotDefinition {
	return {
		name: "Primary Bot",
		instructions: `You are ${member.name}'s Primary Bot, their front door to Hamkey, a private household assistant. Be concise, warm and practical.`,
	};
}
