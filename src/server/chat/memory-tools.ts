import { Type } from "@earendil-works/pi-ai";
import { type ConversationId, defineDoc, defineExtension, defineTool, type DocumentReader, hook, section, ToolTask } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import type { LearnedNotes } from "../memory/learned-notes.ts";
import { LEARNED_CAP } from "../memory/learned-notes.ts";
import { BOT_TOOLS, type MemoryAccess } from "../memory/access.ts";
import type { Fact, Memory } from "../memory/memory.ts";

/** Who a conversation belongs to. Written once when the thread is created, in the same commit, and never from the model. */
export type Binding = { botId: string; memberId: string | null };

export const BindingDoc = defineDoc<Binding>({
	kind: "hamkey.binding",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ botId: "", memberId: null }),
	checkpointWhen: () => false,
});

/** Looks up what a Bot may do for a binding, as the Bot is defined now. Undefined means nothing. */
export type AccessResolver = (binding: Binding) => MemoryAccess | undefined;

const SUMMARY_FACTS = 50;

const describe = (f: Fact) => `[${f.id}] ${f.text}`;
const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });

/**
 * The memory tools and the memory section of the system prompt (ADR 0002). Each tool reads which Bot and Member the
 * conversation belongs to from the conversation's own binding, so its arguments carry no scope and a model cannot name
 * one. The `beforeTool` hook is a second check that the Bot may use the tool at all, not the main control: the tools a
 * thread is offered are chosen when it is created.
 */
export function memoryExtension(memory: Memory, learned: LearnedNotes, resolve: AccessResolver) {
	async function accessOf(read: DocumentReader, id: ConversationId, context: Context) {
		const binding = await read.snapshot(BindingDoc, id, context);
		return binding === undefined || binding.botId === "" ? undefined : resolve(binding);
	}

	const save = defineTool({
		name: "memory_save",
		description: "Remember a fact for later conversations. Use it when the Member asks you to remember something.",
		parameters: Type.Object({ fact: Type.String({ minLength: 1, description: "One fact, in a plain sentence." }) }),
		async execute(args, api, context) {
			const access = await accessOf(api, api.conversationId, context);
			if (access === undefined) throw new Error("Memory is not available here.");
			const fact = await memory.saveFact(access.write, args.fact);
			return text(`Remembered. [${fact.id}]`);
		},
	});

	const search = defineTool({
		name: "memory_search",
		description: "Search what you remember. Give a few words that the fact would contain.",
		parameters: Type.Object({ query: Type.String({ description: "Words to look for." }) }),
		async execute(args, api, context) {
			const access = await accessOf(api, api.conversationId, context);
			if (access === undefined) throw new Error("Memory is not available here.");
			const found = await memory.search(access.read, args.query);
			return text(found.length === 0 ? "Nothing found." : found.slice(0, 20).map(describe).join("\n"));
		},
	});

	const forget = defineTool({
		name: "memory_forget",
		description: "Forget one fact, by the id shown in square brackets by memory_search or in what you remember.",
		parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
		async execute(args, api, context) {
			const access = await accessOf(api, api.conversationId, context);
			if (access === undefined) throw new Error("Memory is not available here.");
			return text((await memory.forget(access.read, args.id)) ? "Forgotten." : "No such fact.");
		},
	});

	// The Bot's own notes. Which file is the Bot's comes from the conversation's binding, so the Bot cannot name another.
	const learn = defineTool({
		name: "learned_update",
		description: `Rewrite your own notes about how to work better with this household: habits, preferences about how you answer. Send the whole new notes, at most ${LEARNED_CAP} characters. This replaces the old notes. Do not put private facts about a Member here; use memory_save for those.`,
		parameters: Type.Object({ notes: Type.String() }),
		async execute(args, api, context) {
			const binding = await api.snapshot(BindingDoc, api.conversationId, context);
			if (binding === undefined || binding.botId === "" || resolve(binding) === undefined) throw new Error("Notes are not available here.");
			await learned.write(binding.botId, args.notes);
			return text("Notes updated.");
		},
	});

	return defineExtension({
		name: "hamkey-memory",
		tools: [save, search, forget, learn],
		sections: [
			section("learned", async (input, context) => {
				const binding = await input.read.snapshot(BindingDoc, input.conversationId, context);
				if (binding === undefined || binding.botId === "" || resolve(binding) === undefined) return undefined;
				const notes = (await learned.read(binding.botId)).trim();
				return notes === "" ? undefined : `Your own notes from earlier conversations:\n${notes}`;
			}),
			// Says which tools the Bot has, so it does not claim to have used one it was not given. Follows edits to the Bot.
			section("capabilities", async (input, context) => {
				const access = await accessOf(input.read, input.conversationId, context);
				if (access === undefined) return undefined;
				const missing = BOT_TOOLS.filter((t) => !access.tools.includes(t));
				return [
					`Tools you have: ${access.tools.length === 0 ? "none" : access.tools.join(", ")}.`,
					missing.length === 0 ? undefined : `Tools you do not have: ${missing.join(", ")}.`,
					"Never say you did something that needs a tool you do not have; say you cannot do it.",
				]
					.filter((l) => l !== undefined)
					.join("\n");
			}),
			section("memory", async (input, context) => {
				const access = await accessOf(input.read, input.conversationId, context);
				if (access === undefined || !access.tools.some((t) => t.startsWith("memory_"))) return undefined;
				const facts = await memory.loadSummary(access.read, SUMMARY_FACTS);
				if (facts.length === 0) return "You remember nothing yet.";
				return `What you remember, newest first:\n${facts.map(describe).join("\n")}`;
			}),
		],
		hooks: [
			hook(ToolTask, {
				async beforeTool(call, api, context) {
					const access = await accessOf(api, api.conversationId, context);
					if (access === undefined || !access.tools.includes(call.name)) return { block: "This tool is not available." };
					return undefined;
				},
			}),
		],
	});
}
