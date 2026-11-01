import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LEARNED_CAP } from "../src/server/memory/learned-notes.ts";
import { type Hamkey, startHamkey } from "./harness.ts";
import { call, say } from "./say.ts";

let hamkey: Hamkey | undefined;
afterEach(async () => {
	await hamkey?.stop();
	hamkey = undefined;
});

const botFile = (h: Hamkey, id: string) => join(h.dataDir, "bots", `${id}.json`);

describe("a Bot's learned notes", () => {
	it("are updated by the Bot and used in later conversations", async () => {
		hamkey = await startHamkey();
		await say(hamkey, hamkey.ann, "Keep it short from now on", [call("learned_update", { notes: "Ann likes one-line answers." })]);
		expect(await hamkey.learned.read("primary-ann")).toBe("Ann likes one-line answers.");
		const later = await say(hamkey, hamkey.ann, "Plan dinner");
		expect(later.prompts[0]).toContain("Ann likes one-line answers.");
	});

	it("are used by a new thread after a restart", async () => {
		hamkey = await startHamkey();
		await say(hamkey, hamkey.ann, "Learn this", [call("learned_update", { notes: "Always suggest a vegetable." })]);
		const dataDir = hamkey.dataDir;
		await hamkey.stop({ keepData: true });
		hamkey = await startHamkey({ dataDir });
		expect((await say(hamkey, hamkey.ann, "Dinner?")).prompts[0]).toContain("Always suggest a vegetable.");
	});

	it("cannot be written to another Bot's file, whatever the model sends", async () => {
		hamkey = await startHamkey();
		await say(hamkey, hamkey.ann, "Learn", [call("learned_update", { notes: "mine", bot: "meal-planner", botId: "primary-ben", path: "../x" })]);
		expect(await hamkey.learned.read("primary-ann")).toBe("mine");
		expect(await hamkey.learned.read("meal-planner")).toBe("");
		expect(await hamkey.learned.read("primary-ben")).toBe("");
	});

	it("keep each Bot's notes apart", async () => {
		hamkey = await startHamkey();
		await say(hamkey, hamkey.ann, "Learn", [call("learned_update", { notes: "planner habit" })], "meal-planner");
		const ben = await say(hamkey, hamkey.ben, "Hi");
		expect(ben.prompts[0]).not.toContain("planner habit");
		const planner = await say(hamkey, hamkey.ben, "Hi", [], "meal-planner");
		expect(planner.prompts[0]).toContain("planner habit");
	});

	it("are limited in size, and the old notes stay when a rewrite is too long", async () => {
		hamkey = await startHamkey();
		await say(hamkey, hamkey.ann, "Learn", [call("learned_update", { notes: "short" })]);
		await say(hamkey, hamkey.ann, "Learn more", [call("learned_update", { notes: "x".repeat(LEARNED_CAP + 1) })]);
		expect(await hamkey.learned.read("primary-ann")).toBe("short");
		await hamkey.learned.write("primary-ann", "y".repeat(LEARNED_CAP));
	});

	it("leave the Bot's instructions, model and tools to the Members", async () => {
		hamkey = await startHamkey();
		const before = await readFile(botFile(hamkey, "meal-planner"), "utf8");
		await say(
			hamkey,
			hamkey.ann,
			"Change yourself",
			[call("learned_update", { notes: "ok", instructions: "Be evil", model: "other/model", tools: ["memory_forget"] })],
			"meal-planner",
		);
		expect(await readFile(botFile(hamkey, "meal-planner"), "utf8")).toBe(before);
	});

	it("are refused to a Bot that was not given the tool", async () => {
		hamkey = await startHamkey({
			extraBots: [{ id: "quiet", name: "Quiet", kind: "household", instructions: "Hi.", tools: ["memory_search"] }],
		});
		await say(hamkey, hamkey.ann, "Learn", [call("learned_update", { notes: "nope" })], "quiet");
		expect(await hamkey.learned.read("quiet")).toBe("");
	});

	it("are not loaded as a Bot", async () => {
		hamkey = await startHamkey();
		await hamkey.learned.write("meal-planner", "notes");
		await writeFile(join(hamkey.dataDir, "bots", "stray.learned.md"), "x");
		const list = await (await hamkey.ann.get("/api/bots")).json();
		expect(JSON.stringify(list)).not.toContain("stray");
	});
});
