import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { Scope } from "../src/server/memory/memory.ts";
import { type Hamkey, startHamkey } from "./harness.ts";
import { call, say, texts } from "./say.ts";

let hamkey: Hamkey | undefined;
afterEach(async () => {
	await hamkey?.stop();
	hamkey = undefined;
});

type Client = Hamkey["ann"];
type Message = { role: string; text: string; sender?: { id: string; name: string } };
type View = { messages: Message[]; busy: boolean; error?: string };

const reply = (text: string) => fauxAssistantMessage([fauxText(text)]);
const view = async (who: Client, bot: string): Promise<View> => (await who.get(`/api/bots/${bot}`)).json();
const failure = () => fauxAssistantMessage([], { stopReason: "error", errorMessage: "boom" });

async function until(check: () => Promise<boolean>, what: string) {
	for (let i = 0; i < 200; i++) {
		if (await check()) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`Timed out waiting for ${what}`);
}
const settled = (who: Client, bot: string) => until(async () => !(await view(who, bot)).busy, "the run to finish");

/**
 * A model response that waits to be released, so a test can send more messages while the run is certainly still going.
 * `seen` holds what the model was shown at each request.
 */
function held(answer: () => ReturnType<typeof fauxAssistantMessage>) {
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	let entered!: () => void;
	const started = new Promise<void>((r) => (entered = r));
	const step = async () => {
		entered();
		await gate;
		return answer();
	};
	return { step, release, started };
}

/** Records the messages the model is shown on each request. */
function recording(seen: string[][], answer: () => ReturnType<typeof fauxAssistantMessage>) {
	return (context: { messages: { role: string; content: unknown }[] }) => {
		seen.push(context.messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))));
		return answer();
	};
}

describe("the shared thread of a Household Bot", () => {
	it("lets both Members read and write it, and nobody else", async () => {
		hamkey = await startHamkey();
		await say(hamkey, hamkey.ann, "Plan Monday", [], "meal-planner");
		await say(hamkey, hamkey.ben, "Make it vegetarian", [], "meal-planner");
		for (const who of [hamkey.ann, hamkey.ben]) {
			const texts = (await view(who, "meal-planner")).messages.filter((m) => m.role === "user").map((m) => m.text);
			expect(texts).toEqual(["Plan Monday", "Make it vegetarian"]);
		}

		const stranger = hamkey.asTailscale("eve@example.com");
		expect((await stranger.get("/api/bots/meal-planner")).status).toBe(403);
		expect((await stranger.send("hello", undefined, "meal-planner")).status).toBe(403);
		expect((await stranger.request("/api/bots/meal-planner/events")).status).toBe(403);
		expect((await view(hamkey.ann, "meal-planner")).messages.map((m) => m.text)).not.toContain("hello");
	});

	it("is marked as shared in the Bot list, and a Personal Bot is not", async () => {
		hamkey = await startHamkey();
		for (const who of [hamkey.ann, hamkey.ben]) {
			const bots: { id: string; shared: boolean }[] = (await (await who.get("/api/bots")).json()).bots;
			expect(bots.find((b) => b.id === "meal-planner")?.shared).toBe(true);
			expect(bots.find((b) => b.id === who.primary)?.shared).toBe(false);
			expect(bots.find((b) => b.id === "research")?.shared).toBe(false);
		}
	});

	it("labels each message with its sender, for the Members and for the Bot", async () => {
		hamkey = await startHamkey();
		await say(hamkey, hamkey.ann, "Plan Monday", [reply("Soup")], "meal-planner");
		await say(hamkey, hamkey.ben, "Make it vegetarian", [reply("Lentil soup")], "meal-planner");
		const labelled = (await view(hamkey.ben, "meal-planner")).messages.map((m) => [m.role, m.sender?.id, m.sender?.name, m.text]);
		expect(labelled).toEqual([
			["user", "ann", "Ann", "Plan Monday"],
			["assistant", "meal-planner", "Meal Planner", "Soup"],
			["user", "ben", "Ben", "Make it vegetarian"],
			["assistant", "meal-planner", "Meal Planner", "Lentil soup"],
		]);
	});

	it("labels the live stream too", async () => {
		hamkey = await startHamkey();
		hamkey.faux.setResponses([reply("Soup")]);
		const live = hamkey.ben.stream((v) => v.messages.some((m) => m.role === "assistant"), 5000, "meal-planner");
		await live.ready;
		await hamkey.ann.send("Plan Monday", undefined, "meal-planner");
		const last = (await live).at(-1)!;
		expect(last.messages.map((m) => (m as Message).sender?.name)).toEqual(["Ann", "Meal Planner"]);
	});

	it("tells the model who wrote each message and that the thread is shared", async () => {
		hamkey = await startHamkey();
		const result = await say(hamkey, hamkey.ann, "Plan Monday", [], "meal-planner");
		const first = result.prompts[0]!;
		// The model sees the sender's name on the message, and is told the thread is shared by Ann and Ben.
		expect(first).toContain("Ann: Plan Monday");
		expect(first).toContain("shared by both Members of the household: Ann and Ben");
		const ben = await say(hamkey, hamkey.ben, "Make it vegetarian", [], "meal-planner");
		expect(ben.prompts[0]).toContain("Ann: Plan Monday");
		expect(ben.prompts[0]).toContain("Ben: Make it vegetarian");
	});

	it("keeps messages plain in a Personal Bot's thread, though it still records who wrote them", async () => {
		hamkey = await startHamkey();
		const result = await say(hamkey, hamkey.ann, "Plan Monday");
		expect(result.prompts[0]).toContain("Plan Monday");
		expect(result.prompts[0]).not.toContain("Ann: Plan Monday");
		expect(result.prompts[0]).not.toContain("shared by both Members");
		const messages = (await view(hamkey.ann, hamkey.ann.primary)).messages;
		expect(messages.map((m) => m.sender?.id)).toEqual(["ann", hamkey.ann.primary]);
	});

	it("saves anything from the shared thread to household memory, whoever asked", async () => {
		hamkey = await startHamkey();
		const household: Scope = { kind: "household" };
		const ann: Scope = { kind: "member", member: "ann" };
		const ben: Scope = { kind: "member", member: "ben" };
		await say(hamkey, hamkey.ben, "Remember we avoid shellfish", [call("memory_save", { fact: "The household avoids shellfish" })], "meal-planner");
		expect(await texts(hamkey, household)).toEqual(["The household avoids shellfish"]);
		expect(await texts(hamkey, ben)).toEqual([]);
		expect(await texts(hamkey, ann)).toEqual([]);
		await say(hamkey, hamkey.ann, "Remember Friday is pizza night", [call("memory_save", { fact: "Friday is pizza night" })], "meal-planner");
		expect(await texts(hamkey, household)).toEqual(["Friday is pizza night", "The household avoids shellfish"]);
		expect(await texts(hamkey, ann)).toEqual([]);
	});
});

describe("messages sent during a run", () => {
	it("are collected into the next reply in the shared thread", async () => {
		hamkey = await startHamkey();
		const first = held(() => reply("Working on Monday"));
		const seen: string[][] = [];
		hamkey.faux.setResponses([first.step, recording(seen, () => reply("Both noted")), recording(seen, () => reply("Spare"))] as never);

		await hamkey.ann.send("Plan Monday", undefined, "meal-planner");
		await first.started;
		await hamkey.ben.send("Nothing with nuts", undefined, "meal-planner");
		await hamkey.ann.send("And keep it cheap", undefined, "meal-planner");
		first.release();
		await until(async () => (await view(hamkey!.ann, "meal-planner")).messages.some((m) => m.text === "Both noted"), "the second reply");
		await settled(hamkey.ann, "meal-planner");

		const messages = (await view(hamkey.ann, "meal-planner")).messages;
		expect(messages.map((m) => m.text)).toEqual(["Plan Monday", "Working on Monday", "Nothing with nuts", "And keep it cheap", "Both noted"]);
		// One reply answers both, and the model saw both together when it wrote it.
		expect(seen).toHaveLength(1);
		expect(seen[0]!.join("\n")).toContain("Ben: Nothing with nuts");
		expect(seen[0]!.join("\n")).toContain("Ann: And keep it cheap");
	});

	it("are collected into the next reply in a personal thread", async () => {
		hamkey = await startHamkey();
		const first = held(() => reply("Hello"));
		const seen: string[][] = [];
		hamkey.faux.setResponses([first.step, recording(seen, () => reply("Got both")), recording(seen, () => reply("Spare"))] as never);

		await hamkey.ann.send("Hi");
		await first.started;
		await hamkey.ann.send("Also this");
		await hamkey.ann.send("And that");
		first.release();
		await until(async () => (await view(hamkey!.ann, hamkey!.ann.primary)).messages.some((m) => m.text === "Got both"), "the second reply");
		await settled(hamkey.ann, hamkey.ann.primary);

		expect((await view(hamkey.ann, hamkey.ann.primary)).messages.map((m) => m.text)).toEqual(["Hi", "Hello", "Also this", "And that", "Got both"]);
		expect(seen).toHaveLength(1);
		expect(seen[0]!.join("\n")).toContain("Also this");
		expect(seen[0]!.join("\n")).toContain("And that");
		expect(seen[0]!.join("\n")).not.toContain("Ann: Also this");
	});
});

describe("a failed run", () => {
	it("does not strand messages queued behind it in the shared thread", async () => {
		hamkey = await startHamkey();
		const first = held(failure);
		hamkey.faux.setResponses([first.step, reply("Answered both"), reply("Spare")] as never);

		await hamkey.ann.send("Plan Monday", undefined, "meal-planner");
		await first.started;
		await hamkey.ben.send("Nothing with nuts", undefined, "meal-planner");
		first.release();
		await until(async () => (await view(hamkey!.ben, "meal-planner")).messages.some((m) => m.text === "Answered both"), "the queued message's answer");
		await settled(hamkey.ben, "meal-planner");

		const after = await view(hamkey.ben, "meal-planner");
		expect(after.messages.at(-1)).toMatchObject({ role: "assistant", text: "Answered both" });
		expect(after.messages.map((m) => m.text)).toContain("Nothing with nuts");
		// The queued message was answered, so the failure of the one before it must not leave the thread looking stuck.
		expect(after.error).toBeUndefined();
	});

	it("does not strand messages queued behind it in a personal thread", async () => {
		hamkey = await startHamkey();
		const first = held(failure);
		hamkey.faux.setResponses([first.step, reply("Answered"), reply("Spare")] as never);

		await hamkey.ann.send("First");
		await first.started;
		await hamkey.ann.send("Second");
		first.release();
		await until(async () => (await view(hamkey!.ann, hamkey!.ann.primary)).messages.some((m) => m.text === "Answered"), "the answer");
		await settled(hamkey.ann, hamkey.ann.primary);
		const after = await view(hamkey.ann, hamkey.ann.primary);
		expect(after.error).toBeUndefined();
		expect(after.messages.at(-1)).toMatchObject({ role: "assistant", text: "Answered" });
	});

	it("still shows the error when nothing queued behind it was answered, and recovers on the next message", async () => {
		hamkey = await startHamkey();
		hamkey.faux.setResponses([failure()]);
		await hamkey.ben.send("Plan Monday", undefined, "meal-planner");
		await until(async () => (await view(hamkey!.ann, "meal-planner")).error !== undefined, "the error");
		hamkey.faux.setResponses([reply("Soup")]);
		await hamkey.ann.send("Try again", undefined, "meal-planner");
		await until(async () => (await view(hamkey!.ann, "meal-planner")).messages.some((m) => m.text === "Soup"), "the answer");
		expect((await view(hamkey.ann, "meal-planner")).error).toBeUndefined();
	});
});
