import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { Scope } from "../src/server/memory/memory.ts";
import type { Hamkey } from "./harness.ts";

export type Client = Hamkey["ann"];
/** Sends one message and waits until the Bot has finished answering it. The model replies with `steps`, then a short answer. */
export async function say(h: Hamkey, who: Client, text: string, steps: unknown[] = [], bot = who.primary) {
	const prompts: string[] = [];
	const record = (message: ReturnType<typeof fauxAssistantMessage>) => (context: { messages: unknown[] }) => {
		// Pi sends the system prompt as part of the messages, so this is everything the model was shown.
		prompts.push(JSON.stringify(context.messages));
		return message;
	};
	h.faux.setResponses([
		...(steps as ReturnType<typeof fauxAssistantMessage>[]).map(record),
		// Spare answers: a compaction asks the model for its summary before the answer.
		...Array.from({ length: 3 }, () => record(fauxAssistantMessage([fauxText("Done.")]))),
	] as never);
	await who.send(text, undefined, bot);
	for (let i = 0; i < 200; i++) {
		const view = await (await who.get(`/api/bots/${bot}`)).json();
		// After a compaction the view holds only recent messages, so look for this message, not a count.
		const sent = view.messages.findLastIndex((m: { role: string; text: string }) => m.role === "user" && m.text === text);
		if (!view.busy && sent !== -1 && view.messages.at(-1).role === "assistant" && view.messages.length > sent + 1) return { prompts, view };
		await new Promise((r) => setTimeout(r, 25));
	}
	const v = await (await who.get(`/api/bots/${bot}`)).json();
	throw new Error(`The Bot did not finish answering: busy=${v.busy} error=${v.error} messages=${v.messages.map((m: { role: string; text: string }) => m.role + ":" + m.text.slice(0, 25))}`);
}

export const call = (name: string, args: Record<string, unknown>) =>
	fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });
export const texts = async (h: Hamkey, ...scopes: Scope[]) => (await h.memory.loadSummary(scopes)).map((f) => f.text).sort();

