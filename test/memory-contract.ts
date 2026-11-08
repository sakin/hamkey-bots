import { describe, expect, it } from "vitest";
import type { Memory, Scope } from "../src/server/memory/memory.ts";

const household: Scope = { kind: "household" };
const ann: Scope = { kind: "member", member: "ann" };
const ben: Scope = { kind: "member", member: "ben" };
const plannerBot: Scope = { kind: "bot", bot: "meal-planner" };
const researchForAnn: Scope = { kind: "bot", bot: "research", member: "ann" };
const researchForBen: Scope = { kind: "bot", bot: "research", member: "ben" };

/** What any `Memory` implementation must do. Call it with a factory that returns a fresh, empty memory. */
export function memoryContract(name: string, create: () => Promise<Memory>) {
	describe(`${name} satisfies the Memory contract`, () => {
		it("returns a saved fact in the summary and in a matching search", async () => {
			const memory = await create();
			const fact = await memory.saveFact(ann, "Ann is allergic to peanuts");
			expect(fact.text).toBe("Ann is allergic to peanuts");
			expect((await memory.loadSummary([ann])).map((f) => f.id)).toEqual([fact.id]);
			expect((await memory.search([ann], "PEANUTS allergic")).map((f) => f.id)).toEqual([fact.id]);
			expect(await memory.search([ann], "shellfish")).toEqual([]);
		});

		it("finds a fact from a loose query and ranks the better fit first", async () => {
			const memory = await create();
			const diet = await memory.saveFact(household, "The household eats vegetarian on Mondays");
			const other = await memory.saveFact(household, "Bins go out on Thursday");
			// One matching word is enough, and a plural finds the singular.
			expect((await memory.search([household], "is there anything about Mondays and our diet?")).map((f) => f.id)).toEqual([diet.id]);
			expect((await memory.search([household], "monday")).map((f) => f.id)).toEqual([diet.id]);
			expect((await memory.search([household], "vegetarian Mondays Thursday bins")).map((f) => f.id).sort()).toEqual([diet.id, other.id].sort());
			const best = await memory.saveFact(household, "Vegetarian dinner on Mondays is pasta");
			expect((await memory.search([household], "vegetarian Mondays pasta")).map((f) => f.id)[0]).toBe(best.id);
			expect(await memory.search([household], "shellfish")).toEqual([]);
		});

		it("keeps scopes apart", async () => {
			const memory = await create();
			await memory.saveFact(household, "We eat dinner at 7");
			await memory.saveFact(ann, "Ann runs on Tuesdays");
			await memory.saveFact(ben, "Ben swims on Fridays");
			await memory.saveFact(plannerBot, "Planner note");
			await memory.saveFact(researchForAnn, "Research for Ann");
			await memory.saveFact(researchForBen, "Research for Ben");
			const texts = async (...scopes: Scope[]) => (await memory.loadSummary(scopes)).map((f) => f.text).sort();
			expect(await texts(ann)).toEqual(["Ann runs on Tuesdays"]);
			expect(await texts(household, ann)).toEqual(["Ann runs on Tuesdays", "We eat dinner at 7"]);
			expect(await texts(researchForAnn)).toEqual(["Research for Ann"]);
			expect(await texts(plannerBot)).toEqual(["Planner note"]);
			expect(await texts()).toEqual([]);
			expect(await memory.search([household], "swims")).toEqual([]);
		});

		it("forgets one fact and leaves the others", async () => {
			const memory = await create();
			const keep = await memory.saveFact(ann, "keep this");
			const drop = await memory.saveFact(ann, "drop this");
			expect(await memory.forget([ann], drop.id)).toBe(true);
			expect((await memory.loadSummary([ann])).map((f) => f.id)).toEqual([keep.id]);
			expect(await memory.forget([ann], drop.id)).toBe(false);
		});

		it("forgets only inside the scopes it is given", async () => {
			const memory = await create();
			const bens = await memory.saveFact(ben, "Ben's fact");
			expect(await memory.forget([ann, household], bens.id)).toBe(false);
			expect(await memory.loadSummary([ben])).toHaveLength(1);
		});

		it("lists newest first and honours a limit", async () => {
			const memory = await create();
			for (const text of ["one", "two", "three"]) {
				await memory.saveFact(household, text);
				await new Promise((r) => setTimeout(r, 2));
			}
			expect((await memory.loadSummary([household])).map((f) => f.text)).toEqual(["three", "two", "one"]);
			expect((await memory.loadSummary([household], 2)).map((f) => f.text)).toEqual(["three", "two"]);
		});

		it("refuses an empty fact", async () => {
			const memory = await create();
			await expect(memory.saveFact(household, "   ")).rejects.toThrow();
		});

		it("keeps every fact when saves happen at once", async () => {
			const memory = await create();
			await Promise.all(Array.from({ length: 20 }, (_, i) => memory.saveFact(household, `fact ${i}`)));
			expect(await memory.loadSummary([household])).toHaveLength(20);
		});

		it("keeps facts private until they are shared under a Topic", async () => {
			const memory = await create();
			const fact = await memory.saveFact(ann, "Ann is vegetarian");
			const other = await memory.saveFact(ann, "Ann dislikes mornings");
			expect(fact.topic).toBeUndefined();
			expect(await memory.listShared(ann, "dietary-needs")).toEqual([]);
			expect(await memory.setTopic([ann], fact.id, "dietary-needs")).toBe(true);
			expect((await memory.listShared(ann, "dietary-needs")).map((f) => f.id)).toEqual([fact.id]);
			expect((await memory.loadSummary([ann])).find((f) => f.id === fact.id)?.topic).toBe("dietary-needs");
			// Only that Topic, only that scope, only that fact.
			expect(await memory.listShared(ann, "evening-availability")).toEqual([]);
			expect(await memory.listShared(ben, "dietary-needs")).toEqual([]);
			expect((await memory.loadSummary([ann])).find((f) => f.id === other.id)?.topic).toBeUndefined();
			// Sharing survives search, and can be taken back.
			expect((await memory.search([ann], "vegetarian"))[0]?.topic).toBe("dietary-needs");
			expect(await memory.setTopic([ann], fact.id, undefined)).toBe(true);
			expect(await memory.listShared(ann, "dietary-needs")).toEqual([]);
		});

		it("shares only inside the scopes it is given, and not a fact that is gone", async () => {
			const memory = await create();
			const bens = await memory.saveFact(ben, "Ben is vegan");
			expect(await memory.setTopic([ann, household], bens.id, "dietary-needs")).toBe(false);
			expect(await memory.listShared(ben, "dietary-needs")).toEqual([]);
			await memory.forget([ben], bens.id);
			expect(await memory.setTopic([ben], bens.id, "dietary-needs")).toBe(false);
		});
	});
}
