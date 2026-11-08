import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { CardStore } from "../card-store.ts";
import { InvalidCard } from "../cards.ts";
import type { Memory } from "../memory/memory.ts";
import { isTopic, topicLabel, TOPICS } from "../memory/topics.ts";
import { type AccessResolver, BindingDoc } from "./memory-tools.ts";

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });

/**
 * The tools that put a Card in front of a Member: `suggest_sharing` and `ask_choice`. They only create a waiting Card
 * and return at once. The tap arrives later, as an HTTP action the server checks, outside any tool call (ADR 0008), so
 * no tool here can approve anything and a Bot has no tool that can. Which Member a Card is for comes from the
 * conversation's binding, never from the arguments.
 */
export function cardsExtension(memory: Memory, cards: CardStore, members: readonly { id: string }[], resolve: AccessResolver) {
	/** Same call, same Card, so a rerun after a crash does not post a second one. */
	const cardId = (taskId: string) => `card-${createHash("sha256").update(taskId).digest("hex").slice(0, 24)}`;

	const suggest = defineTool({
		name: "suggest_sharing",
		description: `Suggest that the Member share one of their saved facts with other Bots, under a Topic. This posts a card in the thread for the Member to approve or reject. Nothing is shared unless they approve, and you cannot approve for them, so never say it is shared. Topics: ${TOPICS.map((t) => `${t.id} (${t.label})`).join(", ")}. Only the Member's own facts can be suggested.`,
		parameters: Type.Object({
			fact_id: Type.String({ description: "The id in square brackets next to the fact in what you remember." }),
			topic: Type.String({ description: `One of: ${TOPICS.map((t) => t.id).join(", ")}.` }),
		}),
		replay: "safe", // the Card's id comes from this call, so a rerun finds the same Card
		async execute(args, api, context) {
			const binding = await api.snapshot(BindingDoc, api.conversationId, context);
			const access = binding === undefined || binding.botId === "" ? undefined : resolve(binding);
			if (binding === undefined || access === undefined || !access.tools.includes("suggest_sharing")) throw new Error("This tool is not available.");
			// Only a Member's own personal facts can be shared. Household facts are already shared with both Members.
			const scope = access.write;
			if (binding.memberId === null || scope?.kind !== "member" || scope.member !== binding.memberId) {
				throw new Error("Only a Member's own personal facts can be suggested for sharing.");
			}
			if (!isTopic(args.topic)) throw new Error(`Unknown topic. Use one of: ${TOPICS.map((t) => t.id).join(", ")}.`);
			const fact = (await memory.loadSummary([scope])).find((f) => f.id === args.fact_id);
			if (fact === undefined) throw new Error("No such fact in your memory. Use the id shown in square brackets.");
			if (fact.topic === args.topic) return text(`That fact is already shared under ${topicLabel(args.topic)}.`);
			const waiting = (await cards.waitingFor(binding.memberId)).find(
				(c) => c.type === "approval" && (c.fields as { fact_id: string; topic: string }).fact_id === fact.id && (c.fields as { topic: string }).topic === args.topic,
			);
			if (waiting === undefined) {
				try {
					await cards.create({
						id: cardId(String(api.taskId)),
						type: "approval",
						thread: String(api.conversationId),
						botId: binding.botId,
						addressees: [binding.memberId],
						fields: { fact_id: fact.id, fact: fact.text, topic: args.topic },
					});
				} catch (error) {
					if (error instanceof InvalidCard) throw new Error(error.message);
					throw error;
				}
			}
			return text(
				`A card asking the Member to share this fact under ${topicLabel(args.topic)} is now waiting in the thread. Nothing is shared yet, and it stays private unless they approve. Do not tell them it is shared.`,
			);
		},
	});

	const choose = defineTool({
		name: "ask_choice",
		description:
			"Ask the Member to pick one of 2 to 6 short options by tapping a card in the thread, instead of typing. Plain text only, no formatting. Their pick arrives as the next message, so stop after asking and wait for it.",
		parameters: Type.Object({
			question: Type.String({ description: "The question, at most 200 characters." }),
			options: Type.Array(Type.String(), { description: "2 to 6 options, each at most 40 characters." }),
		}),
		replay: "safe",
		async execute(args, api, context) {
			const binding = await api.snapshot(BindingDoc, api.conversationId, context);
			const access = binding === undefined || binding.botId === "" ? undefined : resolve(binding);
			if (binding === undefined || access === undefined || !access.tools.includes("ask_choice")) throw new Error("This tool is not available.");
			try {
				await cards.create({
					id: cardId(String(api.taskId)),
					type: "choice",
					thread: String(api.conversationId),
					botId: binding.botId,
					// In a shared thread both Members may answer; in a personal one only its Member.
					addressees: binding.memberId === null ? members.map((m) => m.id) : [binding.memberId],
					fields: { question: args.question, options: args.options },
				});
			} catch (error) {
				if (error instanceof InvalidCard) throw new Error(error.message);
				throw error;
			}
			return text("The card is posted in the thread. Their pick will arrive as the next message. Do not guess an answer; stop and wait for it.");
		},
	});

	return defineExtension({ name: "hamkey-cards", tools: [suggest, choose] });
}
