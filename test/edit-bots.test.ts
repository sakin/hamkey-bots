import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Hamkey, startHamkey } from "./harness.ts";
import { say } from "./say.ts";

let hamkey: Hamkey | undefined;
afterEach(async () => {
	await hamkey?.stop();
	hamkey = undefined;
});

type Client = Hamkey["ann"];
const json = (body: unknown) => JSON.stringify(body);
const create = (client: Client, body: Record<string, unknown>) => client.request("/api/bots", { method: "POST", body: json(body) });
const edit = (client: Client, id: string, body: Record<string, unknown>) =>
	client.request(`/api/bots/${id}`, { method: "PUT", body: json(body) });
const ids = async (client: Client) => (await (await client.get("/api/bots")).json()).bots.map((b: { id: string }) => b.id);
const gardener = { name: "Garden Helper", instructions: "You help with the garden.", kind: "personal" };

describe("creating a Bot", () => {
	it("works straight away, with no restart, and is saved as a file the Operator can edit", async () => {
		hamkey = await startHamkey();
		const res = await create(hamkey.ann, gardener);
		expect(res.status).toBe(201);
		const bot = await res.json();
		expect(bot).toMatchObject({ id: "garden-helper", name: "Garden Helper", kind: "personal", instructions: gardener.instructions });
		expect(await ids(hamkey.ann)).toContain("garden-helper");
		const reply = await say(hamkey, hamkey.ann, "Hello", [], "garden-helper");
		expect(reply.prompts[0]).toContain("You help with the garden.");
		expect(JSON.parse(await readFile(join(hamkey.dataDir, "bots", "garden-helper.json"), "utf8"))).toMatchObject({ owner: "ann" });
	});

	it("keeps a personal Bot private to its creator", async () => {
		hamkey = await startHamkey();
		await create(hamkey.ann, gardener);
		expect(await ids(hamkey.ben)).not.toContain("garden-helper");
		expect((await hamkey.ben.get("/api/bots/garden-helper")).status).toBe(404);
		expect((await hamkey.ben.get("/api/bots/garden-helper/definition")).status).toBe(404);
		expect((await edit(hamkey.ben, "garden-helper", gardener)).status).toBe(404);
	});

	it("shows a new Household Bot to both Members at once", async () => {
		hamkey = await startHamkey();
		await create(hamkey.ann, { ...gardener, name: "Chores", kind: "household" });
		expect(await ids(hamkey.ann)).toContain("chores");
		expect(await ids(hamkey.ben)).toContain("chores");
	});

	it("gives a name that is already taken its own id", async () => {
		hamkey = await startHamkey();
		await create(hamkey.ann, gardener);
		const again = await (await create(hamkey.ben, { ...gardener, kind: "household" })).json();
		expect(again.id).toBe("garden-helper-2");
		// A name that would make the id of a built-in Bot gets its own id instead.
		expect((await (await create(hamkey.ann, { ...gardener, name: "Primary-ann" })).json()).id).toBe("primary-ann-2");
	});

	it("sets the model and tools, and takes the model list from the catalog", async () => {
		hamkey = await startHamkey();
		const catalog = await (await hamkey.ann.get("/api/models")).json();
		expect(catalog.models.length).toBeGreaterThan(0);
		const model = catalog.models[0].id;
		const made = await (await create(hamkey.ann, { ...gardener, model, tools: ["memory_search"] })).json();
		expect(made).toMatchObject({ model, tools: ["memory_search"] });
		expect((await create(hamkey.ann, { ...gardener, name: "Other", model: "not/a-model" })).status).toBe(400);
		expect((await create(hamkey.ann, { ...gardener, name: "Other", tools: ["bash"] })).status).toBe(400);
	});

	it("refuses a name that is reserved or has no letters", async () => {
		hamkey = await startHamkey();
		expect((await create(hamkey.ann, { ...gardener, name: "Primary Bot" })).status).toBe(400);
		expect((await create(hamkey.ann, { ...gardener, name: " primary bot " })).status).toBe(400);
		expect((await create(hamkey.ann, { ...gardener, name: "!!!" })).status).toBe(400);
		expect((await create(hamkey.ann, { ...gardener, name: "Café 2" })).status).toBe(201);
	});

	it("refuses missing fields and a bad kind", async () => {
		hamkey = await startHamkey();
		expect((await create(hamkey.ann, { ...gardener, name: "" })).status).toBe(400);
		expect((await create(hamkey.ann, { ...gardener, instructions: " " })).status).toBe(400);
		expect((await create(hamkey.ann, { ...gardener, kind: "admin" })).status).toBe(400);
		expect((await hamkey.as({}).request("/api/bots", { method: "POST", body: json(gardener) })).status).toBe(403);
	});
});

describe("editing a Bot", () => {
	it("changes the next turn of its existing conversation", async () => {
		hamkey = await startHamkey();
		await say(hamkey, hamkey.ann, "Hello", [], "meal-planner");
		const res = await edit(hamkey.ben, "meal-planner", { name: "Meal Planner", instructions: "Only suggest soup." });
		expect(res.status).toBe(200);
		const next = await say(hamkey, hamkey.ann, "What is for dinner?", [], "meal-planner");
		expect(next.prompts[0]).toContain("Only suggest soup.");
		// Pi sends only what changed, as a new system entry after the earlier ones.
		expect(next.prompts[0]!.indexOf("Only suggest soup.")).toBeGreaterThan(next.prompts[0]!.indexOf("What is for dinner?") - 1);
	});

	it("changes the model of an existing conversation", async () => {
		hamkey = await startHamkey({ extraModels: ["faux-two"] });
		await say(hamkey, hamkey.ann, "Hello", [], "meal-planner");
		const seen: string[] = [];
		await edit(hamkey.ann, "meal-planner", { name: "Meal Planner", instructions: "Plan meals.", model: "faux-two" });
		hamkey.faux.setResponses([
			(_context: unknown, _options: unknown, _state: unknown, model: { id: string }) => {
				seen.push(model.id);
				return fauxAssistantMessage([fauxText("ok")]);
			},
		] as never);
		await hamkey.ann.send("Again", undefined, "meal-planner");
		await new Promise((r) => setTimeout(r, 500));
		expect(seen).toEqual(["faux-two"]);
	});

	it("changes which tools an existing conversation is offered", async () => {
		hamkey = await startHamkey();
		await say(hamkey, hamkey.ann, "Hello", [], "meal-planner");
		await edit(hamkey.ann, "meal-planner", { name: "Meal Planner", instructions: "Plan meals.", tools: [] });
		const next = await say(hamkey, hamkey.ann, "Remember pasta", [], "meal-planner");
		expect(next.prompts[0]).toContain('"toolsRemoved":[{"name":"memory_save"}');
	});

	it("leaves the id and kind alone, and refuses to edit a Primary Bot", async () => {
		hamkey = await startHamkey();
		const res = await edit(hamkey.ann, "meal-planner", { name: "Dinner", instructions: "Plan.", kind: "personal", id: "x", owner: "ann" });
		expect(await res.json()).toMatchObject({ id: "meal-planner", kind: "household", name: "Dinner" });
		expect(await ids(hamkey.ben)).toContain("meal-planner");
		expect((await edit(hamkey.ann, "primary-ann", gardener)).status).toBe(400);
	});

	it("shows a Member the definition of a Bot they may use, for the form", async () => {
		hamkey = await startHamkey();
		const def = await (await hamkey.ann.get("/api/bots/meal-planner/definition")).json();
		expect(def).toMatchObject({ id: "meal-planner", kind: "household", editable: true, model: null });
		expect(def.instructions).toContain("plan the household");
		expect(def.tools).toEqual(expect.arrayContaining(["memory_save"]));
	});
});

describe("hand edits to a Bot's file", () => {
	it("are picked up without a restart, in new and existing conversations", async () => {
		hamkey = await startHamkey();
		await say(hamkey, hamkey.ann, "Hello", [], "meal-planner");
		const file = join(hamkey.dataDir, "bots", "meal-planner.json");
		const bot = JSON.parse(await readFile(file, "utf8"));
		await writeFile(file, json({ ...bot, name: "Chef", instructions: "Be a chef." }));
		expect((await (await hamkey.ann.get("/api/bots")).json()).bots.find((b: { id: string }) => b.id === "meal-planner").name).toBe("Chef");
		const next = await say(hamkey, hamkey.ann, "Dinner?", [], "meal-planner");
		expect(next.prompts[0]).toContain("Be a chef.");
	});

	it("add and remove Bots", async () => {
		hamkey = await startHamkey();
		await writeFile(join(hamkey.dataDir, "bots", "hand-made.json"), json({ id: "hand-made", name: "Hand made", kind: "household", instructions: "Hi." }));
		expect(await ids(hamkey.ben)).toContain("hand-made");
	});

	it("keep the last good Bot when a file is broken, in its place, with a warning and one log line", async () => {
		hamkey = await startHamkey();
		const before = await ids(hamkey.ann);
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await writeFile(join(hamkey.dataDir, "bots", "meal-planner.json"), "{ not json");
			for (let i = 0; i < 3; i++) expect(await ids(hamkey.ann)).toEqual(before);
			const list = (await (await hamkey.ann.get("/api/bots")).json()).bots;
			expect(list.find((b: { id: string }) => b.id === "meal-planner").warning).toMatch(/error/);
			expect(list.find((b: { id: string }) => b.id === "research").warning).toBeUndefined();
			expect(logged).toHaveBeenCalledTimes(1);
			// Fixing the file clears the warning.
			await writeFile(join(hamkey.dataDir, "bots", "meal-planner.json"), json({ id: "meal-planner", name: "Meals", kind: "household", instructions: "Plan." }));
			const fixed = (await (await hamkey.ann.get("/api/bots")).json()).bots.find((b: { id: string }) => b.id === "meal-planner");
			expect(fixed).toMatchObject({ name: "Meals" });
			expect(fixed.warning).toBeUndefined();
		} finally {
			logged.mockRestore();
		}
	});
});
