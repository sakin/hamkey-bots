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
	});
}
