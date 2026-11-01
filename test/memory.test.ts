import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { Scope } from "../src/server/memory/memory.ts";
import { type Hamkey, startHamkey } from "./harness.ts";

let hamkey: Hamkey | undefined;
afterEach(async () => {
	await hamkey?.stop();
	hamkey = undefined;
});

type Client = Hamkey["ann"];
const annScope: Scope = { kind: "member", member: "ann" };
const benScope: Scope = { kind: "member", member: "ben" };
const household: Scope = { kind: "household" };

/** Sends one message and waits until the Bot has finished answering it. The model replies with `steps`, then a short answer. */
async function say(h: Hamkey, who: Client, text: string, steps: unknown[] = [], bot = who.primary) {
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

const call = (name: string, args: Record<string, unknown>) =>
	fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });
const texts = async (h: Hamkey, ...scopes: Scope[]) => (await h.memory.loadSummary(scopes)).map((f) => f.text).sort();

describe("memory", () => {
	it("remembers a fact told to a Bot and has it in front of the Bot in a later conversation turn", async () => {
		hamkey = await startHamkey();
		await say(hamkey, hamkey.ann, "Remember I'm allergic to peanuts", [call("memory_save", { fact: "Ann is allergic to peanuts" })]);
		expect(await texts(hamkey, annScope)).toEqual(["Ann is allergic to peanuts"]);
		const later = await say(hamkey, hamkey.ann, "What am I allergic to?");
		expect(later.prompts.at(0)).toContain("Ann is allergic to peanuts");
	});

	it("searches and forgets one fact", async () => {
		hamkey = await startHamkey();
		const keep = await hamkey.memory.saveFact(annScope, "Ann likes green tea");
		const drop = await hamkey.memory.saveFact(annScope, "Ann likes oat milk");
		await say(hamkey, hamkey.ann, "Forget the oat milk", [call("memory_forget", { id: drop.id })]);
		expect((await hamkey.memory.loadSummary([annScope])).map((f) => f.id)).toEqual([keep.id]);
	});

	it("keeps the other Member's personal memory out of a Personal Bot", async () => {
		hamkey = await startHamkey();
		const bens = await hamkey.memory.saveFact(benScope, "Ben's surprise party is on Friday");
		const result = await say(hamkey, hamkey.ann, "What do you know about Ben?", [
			call("memory_search", { query: "Ben" }),
			call("memory_forget", { id: bens.id }),
		]);
		expect(result.prompts.join("\n")).not.toContain("surprise party");
		expect(await texts(hamkey, benScope)).toEqual(["Ben's surprise party is on Friday"]);
	});

	it("gives Personal Bots household memory and Household Bots household memory only", async () => {
		hamkey = await startHamkey();
		await hamkey.memory.saveFact(household, "The bins go out on Thursday");
		await hamkey.memory.saveFact(annScope, "Ann's private note");
		const personal = await say(hamkey, hamkey.ann, "hi");
		expect(personal.prompts[0]).toContain("The bins go out on Thursday");
		expect(personal.prompts[0]).toContain("Ann's private note");
		const shared = await say(hamkey, hamkey.ann, "hi", [], "meal-planner");
		expect(shared.prompts[0]).toContain("The bins go out on Thursday");
		expect(shared.prompts[0]).not.toContain("Ann's private note");
		await say(hamkey, hamkey.ann, "Remember we are vegetarian on Mondays", [call("memory_save", { fact: "Vegetarian Mondays" })], "meal-planner");
		expect(await texts(hamkey, household)).toContain("Vegetarian Mondays");
		expect(await texts(hamkey, annScope)).toEqual(["Ann's private note"]);
	});

	it("saves only where the server decides, whatever arguments the model adds", async () => {
		hamkey = await startHamkey();
		await say(hamkey, hamkey.ann, "Remember this", [
			call("memory_save", { fact: "Sneaky", scope: "household", member: "ben", kind: "member" }),
		]);
		expect(await texts(hamkey, annScope)).toEqual(["Sneaky"]);
		expect(await texts(hamkey, household, benScope)).toEqual([]);
	});

	it("refuses a tool the Bot was not given, even if the model calls it", async () => {
		hamkey = await startHamkey({
			extraBots: [{ id: "reader", name: "Reader", kind: "household", instructions: "Read only.", tools: ["memory_search"] }],
		});
		await say(hamkey, hamkey.ann, "Remember X", [call("memory_save", { fact: "Should not be saved" })], "reader");
		expect(await texts(hamkey, household)).toEqual([]);
	});

	it("refuses a tool the Bot lost since its thread was made, through the second check", async () => {
		const bot = { id: "reader", name: "Reader", kind: "household", instructions: "Hi." };
		hamkey = await startHamkey({ extraBots: [{ ...bot, tools: ["memory_save", "memory_search"] }] });
		await say(hamkey, hamkey.ann, "Remember Y", [call("memory_save", { fact: "First" })], "reader");
		expect(await texts(hamkey, household)).toEqual(["First"]);
		const dataDir = hamkey.dataDir;
		await hamkey.stop({ keepData: true });
		// The Operator takes `memory_save` away. The old thread was still offered it when it was made.
		await writeFile(join(dataDir, "bots", "reader.json"), JSON.stringify({ ...bot, tools: ["memory_search"] }));
		hamkey = await startHamkey({ dataDir });
		await say(hamkey, hamkey.ann, "Remember Z", [call("memory_save", { fact: "Second" })], "reader");
		expect(await texts(hamkey, household)).toEqual(["First"]);
	});

	it("keeps the link from conversation to Bot and scope across a restart", async () => {
		hamkey = await startHamkey();
		const fact = await hamkey.memory.saveFact(annScope, "Ann plays the cello");
		await say(hamkey, hamkey.ann, "hello");
		const dataDir = hamkey.dataDir;
		await hamkey.stop({ keepData: true });
		hamkey = await startHamkey({ dataDir });
		await say(hamkey, hamkey.ann, "Forget the cello", [call("memory_forget", { id: fact.id })]);
		expect(await texts(hamkey, annScope)).toEqual([]);
		await say(hamkey, hamkey.ann, "Remember the piano", [call("memory_save", { fact: "Ann plays the piano" })]);
		expect(await texts(hamkey, annScope)).toEqual(["Ann plays the piano"]);
		expect(await texts(hamkey, household, benScope)).toEqual([]);
	});

	it("keeps remembered facts after the thread is compacted, and keeps working", async () => {
		hamkey = await startHamkey({
			contextWindow: 3000,
			compaction: { reserveTokens: 500, keepRecentTokens: 400, backgroundTokens: 0 },
		});
		await say(hamkey, hamkey.ann, "Remember my sister is called Maya", [call("memory_save", { fact: "Ann's sister is called Maya" })]);
		const padding = "The quick brown fox jumps over the lazy dog. ".repeat(40);
		for (let i = 0; i < 6; i++) await say(hamkey, hamkey.ann, `${padding} ${i}`);
		const last = await say(hamkey, hamkey.ann, "What is my sister called?");
		// The model's last request no longer holds the early message, yet still shows the fact from memory.
		const request = last.prompts.at(-1)!;
		expect(request).toContain("Ann's sister is called Maya");
		expect(request).not.toContain("Remember my sister is called Maya");
		expect(last.view.messages.at(-1).text).toBe("Done.");
	}, 30_000);
});
