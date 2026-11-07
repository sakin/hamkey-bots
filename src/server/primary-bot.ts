import type { Bot } from "./bots.ts";
import type { Member } from "./members.ts";

/** Every Member has exactly one Primary Bot. It has the same shape as any other Bot; only its origin differs. */
export function primaryBotFor(member: Member): Bot {
	return {
		id: `primary-${member.id}`,
		name: "Primary Bot",
		kind: "personal",
		owner: member.id,
		instructions: `You are ${member.name}'s Primary Bot, their front door to Hamkey, a private household assistant. Be concise, warm and practical.`,
	};
}
