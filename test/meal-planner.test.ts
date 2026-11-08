import { afterEach, describe, expect, it } from "vitest";
import { type Hamkey, startHamkey } from "./harness.ts";
import { call, say } from "./say.ts";
import { askAbout, converse, expose, people, recipeWeb, reply, researchFor, shareFact, tell } from "./scenario.ts";

/**
 * The model is scripted (Pi's faux provider), so these tests prove that the path works end to end and that the right
 * context reaches each model: the Asks, the approved facts, the research, the thread, the saved plan. They say nothing
 * about how well a real model would plan, state a conflict or teach; the Bot's instructions are for that.
 */

let hamkey: Hamkey | undefined;
afterEach(async () => {
	await hamkey?.stop();
	hamkey = undefined;
});

const PLANNER = "meal-planner";
const RECIPES = "https://recipes.example/risotto";

// The facts the Members approve, and facts each keeps private. Private ones carry markers that must never show up.
const ANN_DIET = "Ann is vegetarian";
const ANN_EVENINGS = "Ann is free on Tuesday and Thursday evenings";
const BEN_DIET = "Ben wants fish at least twice a week";
const BEN_EVENINGS = "Ben is out on Wednesday evenings";
const ANN_PRIVATE = "ANN-PRIVATE-DIARY-TURQUOISE";
const BEN_PRIVATE = "BEN-PRIVATE-DEBT-OTTER";

const PLAN = "Mon: mushroom risotto. Tue: lentil curry. Wed: baked salmon (Ben out, Ann cooks). Thu: veggie chili. Fri: fish tacos.";
const CONFLICT = "Ann is vegetarian but Ben wants fish twice a week; I have not picked a side.";
const REVISED = "Mon: mushroom risotto. Tue: lentil curry. Wed: baked salmon. Thu: veggie chili (no fish Thursday). Fri: fish tacos.";

describe("the meal planner is a Seeded Household Bot like any other", () => {
	it("is in a fresh data folder as an ordinary Bot file that names its tools, and never web tools", async () => {
		hamkey = await startHamkey();
		const def = await (await hamkey.ann.get(`/api/bots/${PLANNER}/definition`)).json();
		expect(def).toMatchObject({ id: PLANNER, kind: "household", editable: true });
		expect(def.tools).toEqual(expect.arrayContaining(["memory_save", "memory_search", "research", "ask", "ask_choice"]));
		expect(def.tools.some((t: string) => t.startsWith("web_"))).toBe(false);
		const { seen } = await converse(hamkey, PLANNER, hamkey.ann, "Hello", [reply("Hi.")]);
		expect(seen[0]!.tools).toEqual(expect.arrayContaining(["research", "ask", "memory_save", "ask_choice"]));
		expect(seen[0]!.tools.filter((t) => t.startsWith("web_"))).toEqual([]);
		// Both Members use it, and either may edit it (the same rule as any Bot).
		expect((await hamkey.ben.get(`/api/bots/${PLANNER}/definition`)).status).toBe(200);
	});

	it("is told how to plan a week, state conflicts, save the plan and teach", async () => {
		hamkey = await startHamkey();
		const { instructions } = await (await hamkey.ann.get(`/api/bots/${PLANNER}/definition`)).json();
		for (const phrase of ["dietary-needs", "evening-availability", "research", "plainly", "memory_save", "step by step", "ask that Member directly"]) {
			expect(instructions).toContain(phrase);
		}
	});

	it("does not guess when an Ask is refused: it is told so and a direct question waits for that Member", async () => {
		hamkey = await startHamkey();
		const P = people(hamkey);
		// Ann approved her fact but listed no Bot, so nothing is exposed (the default).
		await shareFact(hamkey, P.ann, "Ann avoids gluten", "dietary-needs");
		const { seen } = await converse(hamkey, PLANNER, P.ben.client, "Plan the week", [
			call("ask", { member: "ann", topic: "dietary-needs", question: "What can Ann eat?" }),
			reply("I could not find out what Ann can eat, so I have asked her."),
		]);
		expect(seen).toHaveLength(2);
		expect(seen[1]!.messages).toContain("has not let you ask about Dietary needs");
		expect(seen[1]!.messages).not.toContain("avoids gluten");
		const waiting = (await (await P.ann.client.get("/api/cards")).json()).cards;
		expect(waiting.map((c: { type: string; status: string; bot: { id: string } }) => [c.type, c.status, c.bot.id])).toEqual([["question", "waiting", PLANNER]]);
	});
});

describe("planning a week in the shared thread", () => {
	it("runs the whole path: share, list, Ask, research, plan, adjust, save, use later, teach", async () => {
		const web = recipeWeb("risotto recipe", RECIPES, "Mushroom risotto", "Mushroom risotto: arborio rice, stock, mushrooms. Stir in stock a ladle at a time for 20 minutes.");
		hamkey = await startHamkey({ web });
		const h = hamkey;
		const { ann, ben } = people(h);

		// 1 and 2. Each Member tells their Primary Bot a dietary need and evening availability and approves sharing it
		// with a tap. Each also has a private fact that is never shared.
		await shareFact(h, ann, ANN_DIET, "dietary-needs");
		await shareFact(h, ann, ANN_EVENINGS, "evening-availability");
		await shareFact(h, ben, BEN_DIET, "dietary-needs");
		await shareFact(h, ben, BEN_EVENINGS, "evening-availability");
		await tell(h, ann, ANN_PRIVATE);
		await tell(h, ben, BEN_PRIVATE);
		expect((await h.memory.listShared(ann.scope, "dietary-needs")).map((f) => f.text)).toEqual([ANN_DIET]);

		// 3. Each lists the meal planner on their Exposure List for both Topics. Nothing else is exposed.
		await expose(h, ann, PLANNER, ["dietary-needs", "evening-availability"]);
		await expose(h, ben, PLANNER, ["dietary-needs", "evening-availability"]);

		// 4 to 7. Ann asks for next week's plan. The meal planner Asks for each Member and Topic, researches, and posts
		// a plan that states the conflict.
		const turn1 = await converse(h, PLANNER, ann.client, "Please plan next week's dinners", [
			...askAbout(ann, "dietary-needs", "What can Ann eat?", `Ann said: ${ANN_DIET}.`),
			...askAbout(ann, "evening-availability", "Which evenings is Ann free?", `Ann said: ${ANN_EVENINGS}.`),
			...askAbout(ben, "dietary-needs", "What does Ben want to eat?", `Ben said: ${BEN_DIET}.`),
			...askAbout(ben, "evening-availability", "Which evenings is Ben free?", `Ben said: ${BEN_EVENINGS}.`),
			...researchFor("Easy vegetarian and fish dinners for a week, with a risotto", "risotto recipe", RECIPES, "Found a mushroom risotto: arborio rice, stock, mushrooms."),
			reply(`${PLAN} ${CONFLICT}`),
		]);
		// Requests: 0 planner, 1 Ask child, 2 planner, 3 child, 4 planner, 5 child, 6 planner, 7 child, 8 planner (research),
		// 9 to 11 Research Bot, 12 planner.
		expect(turn1.seen).toHaveLength(13);
		const asked = [1, 3, 5, 7].map((i) => turn1.seen[i]!);
		// Each Ask conversation saw only that Member's approved facts for that Topic, and has no tools.
		expect(asked[0]!.messages).toContain(ANN_DIET);
		expect(asked[1]!.messages).toContain(ANN_EVENINGS);
		expect(asked[2]!.messages).toContain(BEN_DIET);
		expect(asked[3]!.messages).toContain(BEN_EVENINGS);
		const approved = [ANN_DIET, ANN_EVENINGS, BEN_DIET, BEN_EVENINGS];
		asked.forEach((child, i) => {
			expect(child.tools).toEqual([]);
			for (const other of approved.filter((_, j) => j !== i)) expect(child.messages).not.toContain(other);
		});
		// The answers reached the meal planner, and no private fact reached any model in the whole scenario.
		const last = turn1.seen[12]!.messages;
		for (const fact of approved) expect(last).toContain(fact);
		for (const secret of [ANN_PRIVATE, BEN_PRIVATE]) for (const s of turn1.seen) expect(s.messages).not.toContain(secret);
		// The Research Bot searched and opened a page, and what came back reached the planner, marked as from the web.
		expect(web.searches).toEqual(["risotto recipe"]);
		expect(web.opened).toEqual([RECIPES]);
		expect(last).toContain("Found a mushroom risotto");
		expect(turn1.seen[9]!.tools).toEqual(expect.arrayContaining(["web_search", "web_open"]));
		// The plan and the conflict are posted in the thread both Members read.
		for (const who of [ann, ben]) {
			const view = await (await who.client.get(`/api/bots/${PLANNER}`)).json();
			expect(view.messages.at(-1).text).toBe(`${PLAN} ${CONFLICT}`);
		}
		// Asks are logged for both Members, and answered.
		const log = (await (await ben.client.get("/api/asks")).json()).asks;
		expect(log.map((a: { outcome: string }) => a.outcome)).toEqual(["answered", "answered", "answered", "answered"]);

		// 8. Ben adjusts it in the thread, and the planner revises it with Ben's message labelled as his.
		const turn2 = await converse(h, PLANNER, ben.client, "No fish Thursday please", [reply(REVISED)]);
		expect(turn2.seen[0]!.messages).toContain("Ben");
		expect(turn2.seen[0]!.messages).toContain("No fish Thursday please");
		expect(turn2.seen[0]!.messages).toContain(PLAN);
		expect(turn2.view.messages.at(-1)!.text).toBe(REVISED);
		expect(await h.memory.loadSummary([{ kind: "household" }])).toEqual([]);

		// 9. Once both agree, the final plan is saved to household memory.
		await converse(h, PLANNER, ann.client, "That works for me", [reply("Great. Ben, are you happy with it too?")]);
		const saved = await converse(h, PLANNER, ben.client, "Yes, agreed. Save it.", [call("memory_save", { fact: `Agreed dinner plan: ${REVISED}` }), reply("Saved the plan to household memory.")]);
		expect(saved.view.messages.at(-1)!.text).toBe("Saved the plan to household memory.");
		expect((await h.memory.loadSummary([{ kind: "household" }])).map((f) => f.text)).toEqual([`Agreed dinner plan: ${REVISED}`]);
		for (const member of [ann, ben]) expect((await h.memory.loadSummary([member.scope])).map((f) => f.text)).not.toContain(`Agreed dinner plan: ${REVISED}`);

		// 10. The plan is usable later: a separate conversation, Ben's Primary Bot, sees it in what it remembers.
		const later = await say(h, ben.client, "What are we eating this week?", [reply("Risotto on Monday.")]);
		expect(later.prompts[0]).toContain(`Agreed dinner plan: ${REVISED}`);
		expect(later.prompts[0]).not.toContain(ANN_DIET);

		// 11. Ann asks to be taught the risotto; the planner answers in the thread, with its instructions and the plan in view.
		const teach = await converse(h, PLANNER, ann.client, "Teach me the risotto", [reply("Risotto, step by step: 1. Toast the rice. 2. Add stock a ladle at a time. 3. Stir for 20 minutes.")]);
		expect(teach.seen[0]!.messages).toContain("Teach me the risotto");
		expect(teach.seen[0]!.messages).toContain("Teaching a recipe");
		expect(teach.seen[0]!.messages).toContain(`Agreed dinner plan: ${REVISED}`);
		expect(teach.view.messages.at(-1)!.text).toContain("step by step");
		for (const secret of [ANN_PRIVATE, BEN_PRIVATE]) expect(JSON.stringify(teach.view)).not.toContain(secret);
	});
});
