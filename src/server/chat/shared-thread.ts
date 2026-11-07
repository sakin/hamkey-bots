import { defineExtension, section } from "@earendil-works/pi-durable";
import { BindingDoc } from "./memory-tools.ts";

/**
 * Tells a Bot that its thread is shared, so it can tell the two Members apart. In a Household Bot's thread every
 * message starts with its sender's name (the engine adds it); the Bot cannot see who wrote a message any other way.
 * A thread with no Member in its binding is the shared one.
 */
export function sharedThreadExtension(members: readonly { name: string }[]) {
	return defineExtension({
		name: "hamkey-shared-thread",
		sections: [
			section("shared-thread", async (input, context) => {
				const binding = await input.read.snapshot(BindingDoc, input.conversationId, context);
				if (binding === undefined || binding.botId === "" || binding.memberId !== null) return undefined;
				return [
					`This conversation is shared by both Members of the household: ${members.map((m) => m.name).join(" and ")}.`,
					"Each message starts with the name of the Member who sent it, followed by a colon. Reply to whoever wrote the latest message, and do not confuse one Member's wishes with the other's.",
				].join("\n");
			}),
		],
	});
}
