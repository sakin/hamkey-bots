import { afterEach, describe, expect, it } from "vitest";
import { GENERIC_PUSH } from "../src/server/push.ts";
import { eventually } from "./crash.ts";
import { type Hamkey, startHamkey } from "./harness.ts";
import { call, say } from "./say.ts";
import { askAbout, converse, expose, people, recipeWeb, reply, shareFact, tell } from "./scenario.ts";

/**
 * The spec's V1 finish line (issue #1), walked through as the two Members would walk through it, in order: nine steps,
 * one server restart in the middle, one push to the Member who must act. Everything goes through the HTTP API a phone
 * uses; only the model (Pi's faux provider), the web and the push service are fakes. It proves the whole path holds
 * together. It says nothing about how well a real model plans a week: the manual checklist covers a real model.
 */

let hamkey: Hamkey | undefined;
afterEach(async () => {
	await hamkey?.stop();
	hamkey = undefined;
});

const PLANNER = "meal-planner";
const RESEARCH = "research";
const RECIPES = "https://recipes.example/risotto";

const ANN_DIET = "Ann is vegetarian";
const ANN_NIGHT = "Ann is out on Wednesday evenings";
const BEN_DIET = "Ben wants fish at least twice a week";
const BEN_NIGHT = "Ben is out on Friday evenings";
const ANN_PRIVATE = "ANN-PRIVATE-DIARY-TURQUOISE";
const BEN_PRIVATE = "BEN-PRIVATE-DEBT-OTTER";

const PLAN = "Mon: mushroom risotto. Tue: lentil curry. Wed: baked salmon. Thu: veggie chili. Fri: fish tacos.";
const REVISED = "Mon: mushroom risotto. Tue: lentil curry. Wed: baked salmon. Thu: veggie chili (no fish Thursday). Fri: fish tacos.";

const b64 = (bytes: number, fill: number) => Buffer.alloc(bytes, fill).toString("base64url");
const phone = (name: string) => ({ endpoint: `https://push.example.com/send/${name}`, keys: { p256dh: b64(65, 4), auth: b64(16, 7) } });

type View = { messages: { role: string; text: string }[]; busy: boolean; cards: unknown[] };
/** Waits until the Bot has finished and its last message is an answer. */
const finished = (h: Hamkey, bot: string) =>
	eventually(async () => {
		const v: View = await (await h.ann.get(`/api/bots/${bot}`)).json();
		return !v.busy && v.messages.at(-1)?.role === "assistant" ? v : undefined;
	}, "the Bot to finish");

describe("the V1 finish line", () => {
	it("runs all nine steps, with a restart in the middle and a push to the Member who must act", async () => {
		const web = recipeWeb("risotto recipe", RECIPES, "Mushroom risotto", "Mushroom risotto: arborio rice, stock, mushrooms.").onSearch("surprise gift", [
			{ url: "https://shop.example/tea", title: "Tea sets", snippet: "A lovely tea set" },
		]);
		hamkey = await startHamkey({ web });
		let h = hamkey;
		let { ann, ben } = people(h);
		/** Everything any model was shown after the Members' facts were saved: the Asks, research and planner conversations. */
		const shown: string[] = [];
		const keep = (turn: { seen: { messages: string }[] }) => void shown.push(...turn.seen.map((s) => s.messages));

		// STEP 1. Each Member tells their Primary Bot a fact (a dietary need and a night out) and approves sharing it with a tap.
		// Each also tells a fact that is never shared.
		await shareFact(h, ann, ANN_DIET, "dietary-needs");
		await shareFact(h, ann, ANN_NIGHT, "evening-availability");
		await shareFact(h, ben, BEN_DIET, "dietary-needs");
		await shareFact(h, ben, BEN_NIGHT, "evening-availability");
		await tell(h, ann, ANN_PRIVATE);
		await tell(h, ben, BEN_PRIVATE);
		await expose(h, ann, PLANNER, ["dietary-needs", "evening-availability"]);
		await expose(h, ben, PLANNER, ["dietary-needs", "evening-availability"]);
		// Both Members' phones are registered only now, so every push counted below was caused by the steps after this.
		for (const [who, name] of [[ann, "ann-phone"], [ben, "ben-phone"]] as const) {
			expect((await who.client.request("/api/push/subscriptions", { method: "POST", body: JSON.stringify(phone(name)) })).status).toBe(201);
		}
		await h.pushService.idle();
		h.push.sent.length = 0;

		// STEPS 2, 3, 4 and 7. Ann asks the meal planner for next week's plan in the shared thread. The planner Asks both
		// Primary Bots (four Asks), then calls the Research Bot. The server is stopped while the Research Bot's first model
		// request is in flight, and started again on the same data folder.
		//
		// Why stop and start in this process instead of the real SIGKILL of test/crash.ts: this scenario reads memory, the
		// Exposure List and the fake web from inside the server, and the kill fixture runs a server with none of that. The
		// real-kill behaviour of the same paths (research, Ask, replay) is proved in restart-recovery.test.ts. Here a
		// clean stop leaves the interrupted run on disk exactly as the kill does, and the new server finds it by itself.
		let held!: () => void;
		const inFlight = new Promise<void>((r) => (held = r));
		const record = (message: unknown, hold = false) => async (context: { messages: unknown[] }, options?: { signal?: AbortSignal }) => {
			shown.push(JSON.stringify(context.messages));
			if (hold) {
				held();
				// Never answers until the stop aborts the request (a close waits for running model code, so it must let go).
				await new Promise((resolve) => options?.signal?.addEventListener("abort", resolve));
			}
			return message as ReturnType<typeof reply>;
		};
		h.faux.setResponses([
			...[
				...askAbout(ann, "dietary-needs", "What can Ann eat?", `Ann said: ${ANN_DIET}.`),
				...askAbout(ann, "evening-availability", "Which evenings is Ann free?", `Ann said: ${ANN_NIGHT}.`),
				...askAbout(ben, "dietary-needs", "What does Ben want to eat?", `Ben said: ${BEN_DIET}.`),
				...askAbout(ben, "evening-availability", "Which evenings is Ben free?", `Ben said: ${BEN_NIGHT}.`),
				call("research", { request: "Easy vegetarian and fish dinners for a week, with a risotto" }),
			].map((m) => record(m)),
			record(call("web_search", { query: "risotto recipe" }), true),
		] as never);
		expect((await ann.client.send("Please plan next week's dinners", undefined, PLANNER)).status).toBe(202);
		await inFlight;
		// Mid-run: the thread is busy and no plan exists yet.
		const midway: View = await (await ann.client.get(`/api/bots/${PLANNER}`)).json();
		expect(midway.busy).toBe(true);
		expect(midway.messages.map((m) => m.role)).toEqual(["user"]);
		// Nothing needed a Member yet, so nobody was pushed.
		expect(h.push.sent).toEqual([]);
		const dataDir = h.dataDir;
		await h.stop({ keepData: true });
		hamkey = undefined;

		// The new server resumes the interrupted work as it starts, so the model's answers are queued before that.
		hamkey = await startHamkey({
			dataDir,
			web,
			// The Research Bot's first request is asked again and answered; the four Asks are not run again.
			responses: [
				record(call("web_search", { query: "risotto recipe" })),
				record(call("web_open", { url: RECIPES })),
				record(reply("Found a mushroom risotto: arborio rice, stock, mushrooms.")),
				record(reply(PLAN)),
			],
		});
		h = hamkey;
		({ ann, ben } = people(h)); // the same Members, on the new server's port
		expect(await h.pushService.subscriptionsFor("ben")).toHaveLength(1); // the phones survived the restart
		const plan = await finished(h, PLANNER);
		// The conversation recovered: one question from Ann, one plan, no duplicate message, no error.
		expect(plan.messages.map((m) => `${m.role}:${m.text}`)).toEqual(["user:Please plan next week's dinners", `assistant:${PLAN}`]);
		// STEP 3 (check). The Asks were answered once each, and each saw only that Member's shared facts.
		const log = (await (await ben.client.get("/api/asks")).json()).asks as { outcome: string }[];
		expect(log.map((a) => a.outcome)).toEqual(["answered", "answered", "answered", "answered"]);
		// STEP 4 (check). The Research Bot searched once and opened the one page, even across the restart.
		expect(web.searches).toEqual(["risotto recipe"]);
		expect(web.opened).toEqual([RECIPES]);
		expect(shown.some((p) => p.includes("Found a mushroom risotto"))).toBe(true);
		// Both Members read the plan in the shared thread.
		for (const who of [ann, ben]) expect((await (await who.client.get(`/api/bots/${PLANNER}`)).json()).messages.at(-1).text).toBe(PLAN);
		// Planning and replying sends nobody a push.
		await h.pushService.idle();
		expect(h.push.sent).toEqual([]);

		// STEP 5. Both Members adjust the plan in the thread, and the final plan is saved to household memory.
		const adjust = await converse(h, PLANNER, ben.client, "No fish Thursday please", [reply(REVISED)]);
		keep(adjust);
		expect(adjust.seen[0]!.messages).toContain("No fish Thursday please");
		expect(adjust.view.messages.at(-1)!.text).toBe(REVISED);
		keep(await converse(h, PLANNER, ann.client, "That works for me", [reply("Great. Ben, are you happy too?")]));
		const saved = await converse(h, PLANNER, ben.client, "Yes, agreed. Save it.", [call("memory_save", { fact: `Agreed dinner plan: ${REVISED}` }), reply("Saved the plan.")]);
		keep(saved);
		expect((await h.memory.loadSummary([{ kind: "household" }])).map((f) => f.text)).toEqual([`Agreed dinner plan: ${REVISED}`]);

		// STEP 8. The Member who needs to act gets a push. Ben takes the planner off his evening list; Ann asks whether Ben is
		// free Saturday; the planner's Ask is refused, so a Question Card waits for Ben. Ben gets one push, Ann none.
		const dietaryOnly = { "dietary-needs": [PLANNER], "evening-availability": [] };
		expect((await ben.client.request("/api/exposure", { method: "PUT", body: JSON.stringify({ exposure: dietaryOnly }) })).status).toBe(200);
		keep(await converse(h, PLANNER, ann.client, "Is Ben free on Saturday evening?", [
			call("ask", { member: "ben", topic: "evening-availability", question: "Is Ben free on Saturday evening?" }),
			reply("Ben has not shared that, so I asked him in the thread."),
		]));
		await h.pushService.idle();
		expect(h.push.endpoints).toEqual([phone("ben-phone").endpoint]);
		expect(h.push.sent.map((s) => s.payload)).toEqual([GENERIC_PUSH]);
		const bensList: { id: string; waiting: number }[] = (await (await ben.client.get("/api/bots")).json()).bots;
		expect(bensList.find((b) => b.id === PLANNER)!.waiting).toBe(1);
		const annsList: { id: string; waiting: number }[] = (await (await ann.client.get("/api/bots")).json()).bots;
		expect(annsList.every((b) => !b.waiting)).toBe(true);

		// STEP 9. Ann chats with the Research Bot privately. Ben cannot see it, and the model Ben talks to is not shown it.
		const gifts = await say(h, ann.client, "Look up a surprise gift for Ben", [call("web_search", { query: "surprise gift" }), reply("Try a tea set: https://shop.example/tea")], RESEARCH);
		expect(gifts.view.messages.at(-1)!.text).toContain("tea set");
		const benView = JSON.stringify(await (await ben.client.get(`/api/bots/${RESEARCH}`)).json());
		expect(benView).not.toContain("surprise gift");
		expect(benView).not.toContain("tea set");
		const bensTurn = await say(h, ben.client, "Hello", [reply("Hi Ben.")], RESEARCH);
		expect(bensTurn.prompts.join()).not.toContain("surprise gift");
		expect(bensTurn.prompts.join()).not.toContain("shop.example");

		// STEP 6. An unapproved private fact never appeared: not in any model request of the planner, Ask or research
		// conversations, and not in anything either Member can read.
		const readable = JSON.stringify(
			await Promise.all([ann, ben].flatMap((who) => ["/api/bots", `/api/bots/${PLANNER}`, `/api/bots/${RESEARCH}`, "/api/cards", "/api/asks"].map(async (p) => (await who.client.get(p)).json()))),
		);
		for (const secret of [ANN_PRIVATE, BEN_PRIVATE]) {
			expect(shown.join("\n")).not.toContain(secret);
			expect(bensTurn.prompts.join()).not.toContain(secret);
			expect(readable).not.toContain(secret);
			expect(JSON.stringify(h.push.sent)).not.toContain(secret);
		}
		// The facts that were approved did reach the Ask conversations: the check above is not passing for lack of looking.
		for (const fact of [ANN_DIET, ANN_NIGHT, BEN_DIET, BEN_NIGHT]) expect(shown.join("\n")).toContain(fact);
	}, 60_000);
});
