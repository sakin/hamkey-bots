import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AskLog } from "../src/server/ask-log.ts";
import { type Hamkey, startHamkey } from "./harness.ts";
import { call } from "./say.ts";

let hamkey: Hamkey | undefined;
afterEach(async () => {
	await hamkey?.stop();
	hamkey = undefined;
});

const PLANNER = { id: "planner", name: "Planner", kind: "household", instructions: "Plan meals.", tools: ["ask"] };
/** A Common Bot has a private thread for each Member. */
const SCOUT = { id: "scout", name: "Scout", kind: "common", instructions: "Scout.", tools: ["ask"] };
const SNOOP = { id: "snoop", name: "Snoop", kind: "personal", owner: "ben", instructions: "Snoop.", tools: ["ask"] };
const ann = { kind: "member", member: "ann" } as const;
const reply = (t: string) => fauxAssistantMessage([fauxText(t)]);
const ask = (args: Record<string, unknown>) => call("ask", args);
const dietary = (question: string, member = "ann") => ask({ member, topic: "dietary-needs", question });

/** Scripts the model one response per request, records what it was shown, sends a message and waits for the Bot to finish. */
async function converse(h: Hamkey, bot: string, text: string, steps: unknown[], who: Hamkey["ann"] = h.ben) {
	const prompts: string[] = [];
	const record = (message: unknown) => (context: { messages: unknown[] }) => {
		prompts.push(JSON.stringify(context.messages));
		return message as ReturnType<typeof fauxAssistantMessage>;
	};
	h.faux.setResponses([...steps.map(record), ...Array.from({ length: 4 }, () => record(reply("Done.")))] as never);
	expect((await who.send(text, undefined, bot)).status).toBe(202);
	for (let i = 0; i < 400; i++) {
		const view = await (await who.get(`/api/bots/${bot}`)).json();
		if (!view.busy && view.messages.some((m: { text: string }) => m.text.endsWith(text)) && (view.messages.at(-1).role === "assistant" || view.error !== undefined)) break;
		await new Promise((r) => setTimeout(r, 25));
	}
	return prompts;
}

const allow = async (who: Hamkey["ann"], list: Record<string, string[]>) =>
	expect((await who.request("/api/exposure", { method: "PUT", body: JSON.stringify({ exposure: list }) })).status).toBe(200);
const share = async (h: Hamkey, text: string, topic = "dietary-needs") => h.memory.setTopic([ann], (await h.memory.saveFact(ann, text)).id, topic);
const asks = async (who: Hamkey["ann"]) => (await (await who.get("/api/asks")).json()).asks as Record<string, any>[];
const waiting = async (who: Hamkey["ann"]) => (await (await who.get("/api/cards")).json()).cards as Record<string, any>[];
const threadCards = async (who: Hamkey["ann"], bot: string) => (await (await who.get(`/api/bots/${bot}`)).json()).cards as Record<string, any>[];
const failedChild = () => fauxAssistantMessage([], { stopReason: "error", errorMessage: "model fell over" });

describe("the Ask log", () => {
	it("logs an answered Ask with its question and answer, and both Members read it", async () => {
		hamkey = await startHamkey({ extraBots: [PLANNER] });
		await share(hamkey, "Ann is vegetarian");
		await allow(hamkey.ann, { "dietary-needs": ["planner"] });
		await converse(hamkey, "planner", "Plan dinner", [dietary("What can Ann eat?"), reply("Ann is vegetarian."), reply("Vegetarian it is.")]);
		for (const who of [hamkey.ann, hamkey.ben]) {
			const [entry, ...rest] = await asks(who);
			expect(rest).toEqual([]);
			expect(entry).toMatchObject({ bot: "Planner", about: "Ann", topicLabel: "Dietary needs", question: "What can Ann eat?", outcome: "answered", answer: "Ann is vegetarian." });
			expect(Date.parse(entry!.time)).not.toBeNaN();
		}
	});

	it("logs a refused Ask, an Ask with no approved facts, and a failed Ask, newest first", async () => {
		hamkey = await startHamkey({ extraBots: [PLANNER] });
		// Refused: nothing is listed.
		await converse(hamkey, "planner", "One", [dietary("Refused question?"), reply("ok")]);
		// No facts: listed, but nothing was approved.
		await hamkey.memory.saveFact(ann, "PRIVATE-UNSHARED");
		await allow(hamkey.ann, { "dietary-needs": ["planner"] });
		await converse(hamkey, "planner", "Two", [dietary("Empty question?"), reply("ok")]);
		// Failed: the Primary Bot's turn ends in an error.
		await share(hamkey, "Ann is vegetarian");
		await converse(hamkey, "planner", "Three", [dietary("Failing question?"), failedChild(), reply("ok")]);
		const log = await asks(hamkey.ben);
		expect(log.map((e) => [e.question, e.outcome])).toEqual([
			["Failing question?", "failed"],
			["Empty question?", "no-facts"],
			["Refused question?", "refused"],
		]);
		expect(log[2]!.reason).toContain("has not let you ask about Dietary needs");
		expect(log[1]!.reason).toContain("has not shared anything");
		expect(log[0]!.reason).toContain("could not answer");
		// The reason is for Members; the instruction to the Bot is not repeated in the log.
		expect(JSON.stringify(log)).not.toContain("Do not guess");
		expect(JSON.stringify(log)).not.toContain("PRIVATE-UNSHARED");
	});

	it("shows both Members Asks about either of them, but not the name of the other's private Bot", async () => {
		hamkey = await startHamkey({ extraBots: [PLANNER, SNOOP] });
		const benFact = await hamkey.memory.saveFact({ kind: "member", member: "ben" }, "Ben eats anything");
		await hamkey.memory.setTopic([{ kind: "member", member: "ben" }], benFact.id, "dietary-needs");
		await allow(hamkey.ben, { "dietary-needs": ["planner"] });
		await converse(hamkey, "planner", "About Ben", [dietary("What can Ben eat?", "ben"), reply("Anything."), reply("ok")], hamkey.ann);
		// Ben's private Bot cannot be listed, so its Ask is refused, but it is still logged.
		const made = await converse(hamkey, "snoop", "Snoop on Ann", [dietary("Snoop question?"), reply("ok")], hamkey.ben);
		expect(made.length).toBeGreaterThan(0);
		const annSees = await asks(hamkey.ann);
		expect(annSees.map((e) => [e.about, e.outcome])).toEqual([["Ann", "refused"], ["Ben", "answered"]]);
		expect(annSees[0]!.bot).toBe("A private Bot of Ben");
		expect(JSON.stringify(annSees)).not.toContain("Snoop\"");
		expect((await asks(hamkey.ben))[0]!.bot).toBe("Snoop");
		expect((await asks(hamkey.ben))[1]).toMatchObject({ bot: "Planner", about: "Ben", answer: "Anything." });
	});

	it("refuses a visitor Hamkey does not know", async () => {
		hamkey = await startHamkey({ extraBots: [PLANNER] });
		await converse(hamkey, "planner", "One", [dietary("Secret question?"), reply("ok")]);
		const stranger = hamkey.asTailscale("stranger@example.com");
		const res = await stranger.get("/api/asks");
		expect(res.status).toBe(403);
		expect(await res.text()).not.toContain("Secret question");
		expect((await hamkey.as({}).get("/api/asks")).status).toBe(403);
	});

	it("keeps one entry per Ask, however often the same Ask is recorded or the server restarts", async () => {
		const dir = await mkdtemp(join(tmpdir(), "hamkey-asklog-"));
		try {
			const record = { id: "task-1", askerBotId: "planner", askerMemberId: null, targetMemberId: "ann", topic: "dietary-needs", question: "Q?", outcome: "answered", answer: "A" } as const;
			const log = new AskLog(dir, () => "Planner");
			await Promise.all([log.record(record), log.record(record)]);
			const first = (await log.all())[0]!.time;
			// A fresh object reading the same file is a restart; the rerun of the same Ask adds nothing and keeps the first time.
			const again = new AskLog(dir, () => "Planner");
			await again.record({ ...record, answer: "A different rerun" });
			await again.record({ ...record, id: "task-2" });
			const entries = await again.all();
			expect(entries.map((e) => e.id)).toEqual(["task-2", "task-1"]);
			expect(entries[1]).toMatchObject({ time: first, answer: "A" });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("survives a restart of Hamkey", async () => {
		hamkey = await startHamkey({ extraBots: [PLANNER] });
		await converse(hamkey, "planner", "One", [dietary("Remembered question?"), reply("ok")]);
		const dir = hamkey.dataDir;
		await hamkey.stop({ keepData: true });
		hamkey = await startHamkey({ dataDir: dir });
		expect((await asks(hamkey.ann)).map((e) => e.question)).toEqual(["Remembered question?"]);
	});
});

describe("falling back to the Member", () => {
	it("tells the Bot not to guess and to ask the Member in this thread, after a refused Ask", async () => {
		hamkey = await startHamkey({ extraBots: [PLANNER] });
		await share(hamkey, "Ann is vegetarian");
		const prompts = await converse(hamkey, "planner", "Plan dinner", [dietary("What can Ann eat?"), reply("Ann, what can you eat?")]);
		const result = prompts[1]!;
		expect(result).toContain("has not let you ask about Dietary needs");
		expect(result).toContain("Do not guess or make up an answer");
		expect(result).toContain("ask Ann directly in this thread");
		// The answer that would have come from the approved fact is nowhere in what the Bot saw.
		expect(result).not.toContain("vegetarian");
	});

	it("posts a direct question for the Member in a shared thread when the Ask had no approved facts", async () => {
		hamkey = await startHamkey({ extraBots: [PLANNER] });
		await allow(hamkey.ann, { "dietary-needs": ["planner"] });
		const prompts = await converse(hamkey, "planner", "Plan dinner", [dietary("What can Ann eat?"), reply("Ann, what can you eat?")]);
		expect(prompts[1]).toContain("has not shared anything about Dietary needs");
		expect(prompts[1]).toContain("ask Ann directly in this thread");
		// Ann sees it in the thread and among what waits for her.
		const inThread = await threadCards(hamkey.ann, "planner");
		expect(inThread).toMatchObject([{ type: "question", status: "waiting", bot: { id: "planner", name: "Planner" }, fields: { question: "What can Ann eat?" } }]);
		expect(await waiting(hamkey.ann)).toMatchObject([{ id: inThread[0]!.id, type: "question" }]);
		// Ben, who asked, has nothing to act on: it is not his question.
		expect(await threadCards(hamkey.ben, "planner")).toEqual([]);
		expect(await waiting(hamkey.ben)).toEqual([]);
		// The direct question is also what the Bot said it would do: the Bot's own words are in the thread.
		const view = await (await hamkey.ben.get("/api/bots/planner")).json();
		expect(view.messages.at(-1).text).toBe("Ann, what can you eat?");
	});

	it("posts a direct question after a failed Ask, and the Bot is told not to guess", async () => {
		hamkey = await startHamkey({ extraBots: [PLANNER] });
		await share(hamkey, "Ann is vegetarian");
		await allow(hamkey.ann, { "dietary-needs": ["planner"] });
		const prompts = await converse(hamkey, "planner", "Plan dinner", [dietary("What can Ann eat?"), failedChild(), reply("ok")]);
		expect(prompts[2]).toContain("could not answer right now");
		expect(prompts[2]).toContain("Do not guess or make up an answer");
		expect(prompts[2]).toContain("ask Ann directly in this thread");
		expect(await waiting(hamkey.ann)).toMatchObject([{ type: "question", fields: { question: "What can Ann eat?" } }]);
	});

	it("settles the question when the Member writes in the thread, and not when the other Member does", async () => {
		hamkey = await startHamkey({ extraBots: [PLANNER] });
		await converse(hamkey, "planner", "Plan dinner", [dietary("What can Ann eat?"), reply("Ann, what can you eat?")]);
		expect(await waiting(hamkey.ann)).toHaveLength(1);
		// Ben writing again does not answer Ann's question.
		await converse(hamkey, "planner", "Ann, are you there?", [reply("waiting")], hamkey.ben);
		expect(await waiting(hamkey.ann)).toHaveLength(1);
		await converse(hamkey, "planner", "I eat everything", [reply("Noted.")], hamkey.ann);
		expect(await waiting(hamkey.ann)).toEqual([]);
		expect(await threadCards(hamkey.ann, "planner")).toMatchObject([{ type: "question", status: "answered", resolvedBy: "Ann" }]);
	});

	it("posts one question for each Ask that got no answer", async () => {
		hamkey = await startHamkey({ extraBots: [PLANNER] });
		await converse(hamkey, "planner", "Plan dinner", [dietary("What can Ann eat?"), dietary("And evenings?"), reply("ok")]);
		// Two different Ask calls make two questions; each has its own id, and the log has both.
		expect(await waiting(hamkey.ann)).toHaveLength(2);
		expect((await asks(hamkey.ann)).map((e) => e.outcome)).toEqual(["refused", "refused"]);
	});

	it("posts nothing, and says so, when the Member cannot read the asking Bot's thread", async () => {
		hamkey = await startHamkey({ extraBots: [SCOUT] });
		// Ben's private thread with a Common Bot: Ann cannot read it.
		const prompts = await converse(hamkey, "scout", "What can Ann eat?", [dietary("What can Ann eat?"), reply("I could not find out.")]);
		expect(prompts[1]).toContain("has not let you ask about Dietary needs");
		expect(prompts[1]).toContain("Do not guess or make up an answer");
		expect(prompts[1]).toContain("Ann cannot read this thread");
		expect(prompts[1]).toContain("tell the Member you are talking to that you could not find out");
		expect(prompts[1]).not.toContain("ask Ann directly");
		expect(await waiting(hamkey.ann)).toEqual([]);
		expect(await threadCards(hamkey.ann, "scout")).toEqual([]);
		expect(await waiting(hamkey.ben)).toEqual([]);
		// The Ask itself is still logged for both.
		expect((await asks(hamkey.ann)).map((e) => e.outcome)).toEqual(["refused"]);
	});

	it("counts as a Bot needing the Member, and a Member cannot tap it", async () => {
		hamkey = await startHamkey({ extraBots: [PLANNER] });
		await converse(hamkey, "planner", "Plan dinner", [dietary("What can Ann eat?"), reply("Ann?")]);
		const [card] = await waiting(hamkey.ann);
		for (const body of [{ action: "approve" }, { action: "reject" }, { action: "choose", option: 0 }]) {
			expect((await hamkey.ann.request(`/api/cards/${card!.id}/actions`, { method: "POST", body: JSON.stringify(body) })).status).toBe(400);
		}
		// Not Ben's card: it answers as if it did not exist.
		expect((await hamkey.ben.request(`/api/cards/${card!.id}/actions`, { method: "POST", body: JSON.stringify({ action: "approve" }) })).status).toBe(404);
		expect(await waiting(hamkey.ann)).toHaveLength(1);
	});

	it("keeps the question to plain text and a short length", async () => {
		hamkey = await startHamkey({ extraBots: [PLANNER] });
		await converse(hamkey, "planner", "Go", [dietary(`<script>alert(1)</script> ${"long ".repeat(200)}`), reply("ok")]);
		const [card] = await waiting(hamkey.ann);
		expect(card!.fields.question).not.toMatch(/[<>]/);
		expect(card!.fields.question.length).toBeLessThanOrEqual(200);
		// The log keeps what the Bot actually sent.
		expect((await asks(hamkey.ann))[0]!.question).toContain("<script>");
	});
});
