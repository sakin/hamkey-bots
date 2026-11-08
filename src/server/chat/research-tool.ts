import { Type } from "@earendil-works/pi-ai";
import { AssistantEntry, type ConversationId, configure, defineExtension, defineTool, type Extension, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { researchBot, RESEARCH_BOT_ID } from "../research-bot.ts";
import { type AccessResolver, BindingDoc } from "./memory-tools.ts";
import { untrusted } from "./web-tools.ts";

/**
 * Starts (or finds again, after a restart) the fresh conversation that answers one research request, and sets it up as
 * the Research Bot's, wholly from scratch. A task-owned conversation starts as a copy of its owner's agent, so every
 * field of it is replaced here, in the same commit that creates it: the Research Bot's instructions and model, only the
 * web tools, and an explicit list of extensions (never the research tool, so it cannot call itself). Every research
 * request goes through this one function, so no path leaves the caller's tools, instructions or thread in the child.
 * The binding names the Research Bot, with the caller's Member (absent for a Household Bot), so web access does not
 * depend on which kind of Bot asked.
 */
export async function researchConversation(
	tx: Tx,
	taskId: TaskId,
	callerId: ConversationId,
	setup: { model: { provider: string; modelId: string }; extensions: readonly Extension[]; tools: NonNullable<Extension["tools"]> },
): Promise<ConversationId> {
	const caller = await tx.doc(BindingDoc, callerId);
	const existing = (await tx.scanConversations({ ownerTaskId: taskId }, 1)).items[0];
	const id = existing?.id ?? (await tx.createConversation({ ownership: { kind: "task", taskId } })).id;
	await configure(tx, id, {
		model: setup.model,
		instructions: researchBot().instructions,
		extensions: setup.extensions,
		tools: setup.tools,
		thinkingLevel: null,
		modelTools: null,
		cwd: null,
	});
	Object.assign(await tx.doc(BindingDoc, id), { botId: RESEARCH_BOT_ID, memberId: caller.memberId });
	return id;
}

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });

type Block = { type: string; text?: string };
const textOf = (content: unknown): string =>
	Array.isArray(content) ? (content as Block[]).filter((b) => b.type === "text").map((b) => b.text ?? "").join("") : typeof content === "string" ? content : "";

/**
 * The `research` tool (ADR 0004): a Bot that has it sends the Research Bot a request and gets text back, marked
 * untrusted. It follows Pi Durable's subagent pattern ("Abort and Subagents"): the tool is replay-safe, and the child
 * is owned by the call, so aborting the call aborts the research.
 */
export function researchExtension(resolve: AccessResolver, setup: Parameters<typeof researchConversation>[3]) {
	const research = defineTool({
		name: "research",
		description:
			"Look something up on the web. Send a request in plain words and get back what the Research Bot found, with sources. It starts fresh each time and sees only your request, none of this conversation, so put in what it needs to know and nothing private.",
		parameters: Type.Object({ request: Type.String({ minLength: 1, maxLength: 2000, description: "What to find out, as a self-contained request." }) }),
		replay: "safe", // a rerun after a crash finds the same child and the same submission
		async execute(args, api, context) {
			const binding = await api.snapshot(BindingDoc, api.conversationId, context);
			const access = binding === undefined || binding.botId === "" ? undefined : resolve(binding);
			if (access === undefined || !access.tools.includes("research")) throw new Error("This tool is not available.");

			const child = await api.commit((tx) => researchConversation(tx, api.taskId, api.conversationId, setup), context);
			await api.details({ conversationId: child }, context);
			const conversation = await api.conversation(child, context);
			if (conversation === undefined) throw new Error("The research could not be started.");
			const submission = await conversation.submit({ type: "input", content: args.request, requestId: `research:${api.taskId}` }, context);
			const settled = await submission.wait(context);
			if (settled.status !== "done" || settled.type !== "input") throw new Error("The Research Bot could not answer this request. Try again later or without it.");
			const answer = await api.commit(async (tx) => (await tx.entry(AssistantEntry, settled.answer))?.model?.[0], context);
			const reply = textOf(answer?.content).trim();
			if (reply === "") throw new Error("The Research Bot gave no answer.");
			return text(untrusted("Research Bot", reply));
		},
	});
	return defineExtension({ name: "hamkey-research", tools: [research] });
}
