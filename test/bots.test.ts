import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { loadBots } from "../src/server/bots.ts";
import { type Hamkey, ann, ben, startHamkey } from "./harness.ts";

let hamkey: Hamkey | undefined;
afterEach(async () => {
	await hamkey?.stop();
	hamkey = undefined;
});

const list = async (client: Hamkey["ann"]) => (await (await client.get("/api/bots")).json()).bots;

async function say(client: Hamkey["ann"], bot: string, text: string, reply: string) {
	hamkey!.faux.setResponses([fauxAssistantMessage([fauxText(reply)])]);
	const live = client.stream((v) => v.messages.some((m) => m.role === "assistant"), 5000, bot);
	await live.ready;
	await client.send(text, undefined, bot);
	return (await live).at(-1)!;
}

describe("Bot list", () => {
	it("shows each Member only the Bots they may use, with each kind", async () => {
		hamkey = await startHamkey();
		expect(await list(hamkey.ann)).toEqual([
			{ id: "primary-ann", name: "Primary Bot", kind: "personal", shared: false, editable: false, waiting: 0 },
			{ id: "research", name: "Research Bot", kind: "common", shared: false, editable: false, waiting: 0, web: true },
			{ id: "meal-planner", name: "Meal Planner", kind: "household", shared: true, editable: true, waiting: 0 },
			{ id: "trip-planner", name: "Trip Planner", kind: "personal", shared: false, editable: true, waiting: 0 },
		]);
		const bens = await list(hamkey.ben);
		expect(bens.map((b: { id: string }) => b.id)).toEqual(["primary-ben", "research", "meal-planner"]);
	});

	it("loads live Bots from the data folder", async () => {
		const dir = await mkdtemp(join(tmpdir(), "hamkey-bots-"));
		await mkdir(join(dir, "bots"));
		await writeFile(
			join(dir, "bots", "garden.json"),
			JSON.stringify({ id: "garden", name: "Garden", kind: "household", instructions: "Help with the garden." }),
		);
		expect((await loadBots(dir, [ann, ben])).map((b) => b.id)).toEqual(["garden"]);
		expect(await loadBots(await mkdtemp(join(tmpdir(), "hamkey-bots-")), [ann, ben])).toEqual([]);
	});

	it("rejects a malformed Bot file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "hamkey-bots-"));
		await mkdir(join(dir, "bots"));
		const write = (name: string, bot: object) => writeFile(join(dir, "bots", `${name}.json`), JSON.stringify(bot));
		const ok = { id: "x", name: "X", kind: "household", instructions: "Hi" };
		await write("x", { ...ok, kind: "secret" });
		await expect(loadBots(dir, [ann, ben])).rejects.toThrow(/kind/);
		await write("x", { ...ok, kind: "personal" });
		await expect(loadBots(dir, [ann, ben])).rejects.toThrow(/owner/);
		await write("x", { ...ok, kind: "personal", owner: "eve" });
		await expect(loadBots(dir, [ann, ben])).rejects.toThrow(/owner/);
		await write("x", { ...ok, id: "y" });
		await expect(loadBots(dir, [ann, ben])).rejects.toThrow(/file name/);
	});
});

describe("switching Bots", () => {
	it("keeps each Bot's own continuous thread", async () => {
		hamkey = await startHamkey();
		await say(hamkey.ann, "primary-ann", "Hello primary", "Hi from primary");
		await say(hamkey.ann, "meal-planner", "What's for dinner", "Pasta");
		const primary = await (await hamkey.ann.get("/api/bots/primary-ann")).json();
		const meals = await (await hamkey.ann.get("/api/bots/meal-planner")).json();
		expect(primary.messages.map((m: { text: string }) => m.text)).toEqual(["Hello primary", "Hi from primary"]);
		expect(meals.messages.map((m: { text: string }) => m.text)).toEqual(["What's for dinner", "Pasta"]);
	});
});

describe("thread isolation (ADR 0005)", () => {
	it("gives a Member no way to read or write another Member's personal Bot", async () => {
		hamkey = await startHamkey();
		await say(hamkey.ann, "primary-ann", "Ann's secret", "Noted");
		await say(hamkey.ann, "trip-planner", "Surprise trip", "Lovely");
		for (const bot of ["primary-ann", "trip-planner"]) {
			expect((await hamkey.ben.get(`/api/bots/${bot}`)).status).toBe(404);
			expect((await hamkey.ben.send("snoop", undefined, bot)).status).toBe(404);
			expect((await hamkey.ben.request(`/api/bots/${bot}/events`)).status).toBe(404);
		}
		// Ann's thread is untouched by the attempt.
		const ann = await (await hamkey.ann.get("/api/bots/primary-ann")).json();
		expect(JSON.stringify(ann)).not.toContain("snoop");
	});

	it("answers an unusable Bot exactly like one that does not exist", async () => {
		hamkey = await startHamkey();
		const forbidden = await hamkey.ben.get("/api/bots/trip-planner");
		const missing = await hamkey.ben.get("/api/bots/no-such-bot");
		expect(forbidden.status).toBe(missing.status);
		expect(await forbidden.json()).toEqual(await missing.json());
	});

	it("does not accept a thread ID in place of a Bot", async () => {
		hamkey = await startHamkey();
		await say(hamkey.ann, "primary-ann", "Mine", "Ok");
		const saved = JSON.parse(await readFile(join(hamkey.dataDir, "threads.json"), "utf8"));
		const guessed = saved["primary-ann:ann"];
		expect(guessed).toBeTruthy();
		expect((await hamkey.ben.get(`/api/bots/${guessed}`)).status).toBe(404);
		expect((await hamkey.ben.send("snoop", undefined, guessed)).status).toBe(404);
	});

	it("gives a common Bot a separate private thread for each Member", async () => {
		hamkey = await startHamkey();
		await say(hamkey.ann, "research", "Ann asks about visas", "Here are visas");
		const ben = await (await hamkey.ben.get("/api/bots/research")).json();
		expect(ben.messages).toEqual([]);
		await say(hamkey.ben, "research", "Ben asks about bikes", "Here are bikes");
		const ann = await (await hamkey.ann.get("/api/bots/research")).json();
		expect(JSON.stringify(ann)).not.toContain("bikes");
	});

	it("never carries one Member's common Bot stream to the other", async () => {
		hamkey = await startHamkey();
		const bens = hamkey.ben.stream((v) => v.messages.length > 0, 1500, "research");
		await bens.ready;
		await say(hamkey.ann, "research", "Ann only", "Reply");
		await expect(bens).rejects.toThrow();
	});

	it("gives a household Bot one thread that both Members share", async () => {
		hamkey = await startHamkey();
		await say(hamkey.ann, "meal-planner", "Plan Monday", "Soup");
		const ben = await (await hamkey.ben.get("/api/bots/meal-planner")).json();
		expect(ben.messages.map((m: { text: string }) => m.text)).toEqual(["Plan Monday", "Soup"]);
	});
});
