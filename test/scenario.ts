/**
 * Reusable steps for tests that walk a household through Hamkey the way Members do: share a fact, list a Bot on the
 * Exposure List, and script a Bot that Asks and researches. The meal planner test uses them, and so can the v1 finish
 * line test. Everything goes through the HTTP API a Member's phone uses; only the model's replies are scripted.
 */
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { Scope } from "../src/server/memory/memory.ts";
import { FakeWeb } from "./fake-web.ts";
import type { Hamkey } from "./harness.ts";
import { call, type Client, say } from "./say.ts";

export const reply = (text: string) => fauxAssistantMessage([fauxText(text)]);

/** Members as the tests see them: which client, and which scope their personal facts live in. */
export type Person = { id: string; name: string; client: Client; scope: Scope };
export const people = (h: Hamkey): { ann: Person; ben: Person } => ({
	ann: { id: "ann", name: "Ann", client: h.ann, scope: { kind: "member", member: "ann" } },
	ben: { id: "ben", name: "Ben", client: h.ben, scope: { kind: "member", member: "ben" } },
});

/** A Member tells their Primary Bot a fact. It is saved privately, shared with no one. Returns the fact's id. */
export async function tell(h: Hamkey, who: Person, fact: string): Promise<string> {
	await say(h, who.client, `Remember: ${fact}`, [call("memory_save", { fact })]);
	const saved = (await h.memory.loadSummary([who.scope])).find((f) => f.text === fact);
	if (saved === undefined) throw new Error(`The fact was not saved: ${fact}`);
	return saved.id;
}

/** A Member tells their Primary Bot a fact, the Bot suggests sharing it under a Topic, and the Member taps Approve. */
export async function shareFact(h: Hamkey, who: Person, fact: string, topic: string): Promise<string> {
	const id = await tell(h, who, fact);
	await say(h, who.client, `Share that under ${topic}`, [call("suggest_sharing", { fact_id: id, topic })]);
	const waiting: { id: string; fields: { fact?: string } }[] = (await (await who.client.get("/api/cards")).json()).cards;
	const card = waiting.find((c) => c.fields.fact === fact);
	if (card === undefined) throw new Error(`No Approval Card is waiting for: ${fact}`);
	const tapped = await who.client.request(`/api/cards/${card.id}/actions`, { method: "POST", body: JSON.stringify({ action: "approve" }) });
	if (tapped.status !== 200) throw new Error(`Approving failed with ${tapped.status}`);
	return id;
}

/** A Member lists a Bot on their Exposure List for the given Topics, as on their Sharing screen. Other entries stay. */
export async function expose(h: Hamkey, who: Person, bot: string, topics: string[]): Promise<void> {
	const current: Record<string, string[]> = (await (await who.client.get("/api/exposure")).json()).exposure;
	const next = Object.fromEntries(Object.entries(current).map(([topic, bots]) => [topic, topics.includes(topic) ? [...new Set([...bots, bot])] : bots]));
	const saved = await who.client.request("/api/exposure", { method: "PUT", body: JSON.stringify({ exposure: next }) });
	if (saved.status !== 200) throw new Error(`Saving the Exposure List failed with ${saved.status}`);
}

/** What the model was shown at one request: everything as text, and the tools it was offered. */
export type Seen = { messages: string; tools: string[] };

/**
 * Scripts the model one response per request, in order, recording what each request showed it, then sends `text` and
 * waits for the Bot to finish. A Bot's Ask conversations and research requests are requests too, so a script lists them
 * in the order they happen: the Bot's call, then the child's reply, then the Bot's next call. After the script, a few
 * spare answers keep a stray request from hanging.
 */
export async function converse(h: Hamkey, bot: string, who: Client, text: string, steps: unknown[]) {
	const seen: Seen[] = [];
	type Sys = { role: string; toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] };
	const record = (message: unknown) => (context: { messages: Sys[] }) => {
		const offered = new Set<string>();
		for (const m of context.messages) if (m.role === "system") {
			for (const t of m.toolsAdded ?? []) offered.add(t.name);
			for (const t of m.toolsRemoved ?? []) offered.delete(t.name);
		}
		seen.push({ messages: JSON.stringify(context.messages), tools: [...offered] });
		return message as ReturnType<typeof fauxAssistantMessage>;
	};
	h.faux.setResponses([...steps.map(record), ...Array.from({ length: 4 }, () => record(reply("Done.")))] as never);
	const sent = await who.send(text, undefined, bot);
	if (sent.status !== 202) throw new Error(`Sending failed with ${sent.status}`);
	type View = { messages: { role: string; text: string }[]; busy: boolean; error?: string; cards: { type: string; status: string; fields: Record<string, unknown> }[] };
	let view: View = { messages: [], busy: true, cards: [] };
	for (let i = 0; i < 600; i++) {
		view = await (await who.get(`/api/bots/${bot}`)).json();
		const at = view.messages.findLastIndex((m) => m.role === "user" && m.text.endsWith(text));
		if (!view.busy && at !== -1 && (view.messages.at(-1)!.role === "assistant" || view.error !== undefined) && view.messages.length > at + 1) break;
		await new Promise((r) => setTimeout(r, 25));
	}
	if (view.busy) throw new Error("The Bot did not finish answering.");
	return { seen, view };
}

/** Steps for an Ask to a Member's Primary Bot, and what that Primary Bot answers from its approved facts. */
export const askAbout = (who: Person, topic: string, question: string, answer: string) => [call("ask", { member: who.id, topic, question }), reply(answer)];

/** Steps for one research request: the Bot's call, then the Research Bot searches, opens a result and answers. */
export const researchFor = (request: string, query: string, url: string, answer: string) => [
	call("research", { request }),
	call("web_search", { query }),
	call("web_open", { url }),
	reply(answer),
];

/** A web with one recipe search and its page. */
export const recipeWeb = (query: string, url: string, title: string, text: string) =>
	new FakeWeb().onSearch(query, [{ url, title, snippet: text.slice(0, 60) }]).onPage(url, { title, text });
