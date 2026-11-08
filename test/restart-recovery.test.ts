import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { Crashes, eventually, release, runs, sleep, type View } from "./crash.ts";
import { ann, ben, type Hamkey, startHamkey } from "./harness.ts";

/**
 * What a Member sees when the server is killed (SIGKILL, no close) and started again on the same data folder. The kills
 * are real: Hamkey runs as a child process (see `fixtures/faux-server.ts`). A restarted server is either another child
 * or, when a test needs to look inside the engine, a normal in-process `startHamkey` on the same folder.
 */
const crashes = new Crashes();
let hamkey: Hamkey | undefined;
afterEach(async () => {
	await hamkey?.stop();
	hamkey = undefined;
	await crashes.cleanup();
});

const BOT = "primary-ann";
const reply = (text: string) => fauxAssistantMessage([fauxText(text)]);

/** Waits until the Bot has finished and its last message is an answer. */
const finished = (h: Hamkey, bot = BOT) =>
	eventually(async () => {
		const v: View = await (await h.ann.get(`/api/bots/${bot}`)).json();
		return !v.busy && v.messages.at(-1)?.role === "assistant" ? v : undefined;
	}, "the Bot to finish");

const toolStarted = (check: () => Promise<boolean>) => eventually(async () => ((await check()) ? true : undefined), "the tool to start");

describe("restart recovery", () => {
	it("finishes a conversation whose server was killed mid-run, with the message submitted once", async () => {
		const folders = await crashes.folders();
		const first = await crashes.start(folders, [{ text: "Hello Ann", reached: "answer", hold: true }]);
		expect((await first.send(ann, BOT, "Hi there", "tap-1")).status).toBe(202);
		await first.reached("answer");
		expect((await first.view(ann, BOT)).busy).toBe(true);
		await first.kill();

		// A new process on the same data folder picks the work up on its own: no request is needed to wake it.
		const second = await crashes.start(folders, [{ text: "Hello Ann" }]);
		const view = await second.answered(ann, BOT);
		expect(view.messages.map((m) => `${m.role}:${m.text}`)).toEqual(["user:Hi there", "assistant:Hello Ann"]);
		expect(view.error).toBeUndefined();

		// The phone never heard the 202, so it sends the same message again with the same request id: not a second message.
		expect((await second.send(ann, BOT, "Hi there", "tap-1")).status).toBe(202);
		await new Promise((r) => setTimeout(r, 300));
		const after = await second.answered(ann, BOT);
		expect(after.messages.map((m) => `${m.role}:${m.text}`)).toEqual(["user:Hi there", "assistant:Hello Ann"]);
		// The model was asked for the one answer in each process and not again for the resend.
		expect(await crashes.prompts(folders.control)).toHaveLength(2);
	});

	it("does not run a tool that is not replay-safe again, and tells the model it was interrupted", async () => {
		const folders = await crashes.folders();
		const first = await crashes.start(folders, [{ call: ["effect_unsafe", {}] }]);
		await first.send(ann, BOT, "Do the thing");
		await toolStarted(async () => (await runs(folders.control, "effect_unsafe")) === 1);
		await first.kill();
		// The tool would finish now if it were run again.
		await release(folders.control);

		const second = await crashes.start(folders, [{ text: "It was interrupted." }]);
		const view = await second.answered(ann, BOT);
		expect(view.messages.at(-1)!.text).toBe("It was interrupted.");
		expect(await runs(folders.control, "effect_unsafe")).toBe(1);
		// The model's next request carries the interrupted result, not a success.
		const prompts = await crashes.prompts(folders.control);
		const next = prompts.at(-1)!;
		expect(next).toMatch(/effect_unsafe was interrupted and may have partially run/);
		expect(next).not.toContain("effect_unsafe finished");
	});

	it("runs a replay-safe tool again after a kill", async () => {
		const folders = await crashes.folders();
		const first = await crashes.start(folders, [{ call: ["effect_safe", {}] }]);
		await first.send(ann, BOT, "Do the safe thing");
		await toolStarted(async () => (await runs(folders.control, "effect_safe")) === 1);
		await first.kill();
		await release(folders.control);

		const second = await crashes.start(folders, [{ text: "Safe and done." }]);
		const view = await second.answered(ann, BOT);
		expect(view.messages.at(-1)!.text).toBe("Safe and done.");
		expect(await runs(folders.control, "effect_safe")).toBe(2);
		expect((await crashes.prompts(folders.control)).at(-1)).toContain("effect_safe finished");
	});

	it("sends a message once when the same request id arrives twice in one process", async () => {
		hamkey = await startHamkey();
		hamkey.faux.setResponses([reply("Hello"), reply("Spare")]);
		expect((await hamkey.ann.send("Hi", "dup-1")).status).toBe(202);
		expect((await hamkey.ann.send("Hi", "dup-1")).status).toBe(202);
		const view = await finished(hamkey);
		expect(view.messages.filter((m) => m.role === "user")).toHaveLength(1);
		expect(hamkey.faux.state.callCount).toBe(1);
		// The id is the Member's own: Ben sending the same id to his Bot is his own message, not a repeat of Ann's.
		hamkey.faux.setResponses([reply("Hello Ben")]);
		await hamkey.ben.send("Hi", "dup-1");
		const bens: View = await eventually(async () => {
			const v: View = await (await hamkey!.ben.get("/api/bots/primary-ben")).json();
			return !v.busy && v.messages.at(-1)?.role === "assistant" ? v : undefined;
		}, "Ben's answer");
		expect(bens.messages.filter((m) => m.role === "user")).toHaveLength(1);
	});

	it("sends a message once when the same request id arrives again after a restart", async () => {
		hamkey = await startHamkey();
		hamkey.faux.setResponses([reply("Hello")]);
		await hamkey.ann.send("Hi", "dup-2");
		await finished(hamkey);
		const dataDir = hamkey.dataDir;
		await hamkey.stop({ keepData: true });

		hamkey = await startHamkey({ dataDir });
		hamkey.faux.setResponses([reply("Never asked")]);
		expect((await hamkey.ann.send("Hi", "dup-2")).status).toBe(202);
		await sleep(300);
		const view: View = await (await hamkey.ann.get(`/api/bots/${BOT}`)).json();
		expect(view.messages.map((m) => `${m.role}:${m.text}`)).toEqual(["user:Hi", "assistant:Hello"]);
		expect(hamkey.faux.state.callCount).toBe(0);
	});
});

describe("restart recovery of research and Ask calls", () => {
	const SCOUT = { id: "scout", name: "Scout", kind: "household", instructions: "Scout.", tools: ["research"] };

	it("resumes an interrupted research call in the same child conversation", async () => {
		const folders = await crashes.folders();
		const first = await crashes.start(
			folders,
			[
				{ call: ["research", { request: "gifts" }] },
				{ call: ["web_search", { query: "gifts" }] },
				{ text: "A tea set.", reached: "child", hold: true },
			],
			{ extraBots: [SCOUT] },
		);
		await first.send(ann, "scout", "Find a gift");
		await first.reached("child");
		await first.kill();

		hamkey = await startHamkey({ dataDir: folders.dataDir, extraBots: [SCOUT] });
		hamkey.faux.setResponses([reply("A tea set."), reply("Try a tea set.")]);
		const view = await finished(hamkey, "scout");
		expect(view.messages.map((m) => `${m.role}:${m.text}`)).toEqual(["user:Find a gift", "assistant:Try a tea set."]);
		// One thread and one research child: the rerun found the child again instead of making another.
		expect(await hamkey.engine.conversationCount()).toBe(2);
		// The child's one request was answered once, then the Bot's own: two model requests after the restart.
		expect(hamkey.faux.state.callCount).toBe(2);
	});

	const PLANNER = { id: "planner", name: "Planner", kind: "household", instructions: "Planner.", tools: ["ask"] };

	it("resumes an interrupted Ask in the same child conversation, with one log entry", async () => {
		hamkey = await startHamkey({ extraBots: [PLANNER] });
		const fact = await hamkey.memory.saveFact({ kind: "member", member: "ann" }, "Ann is vegetarian");
		await hamkey.memory.setTopic([{ kind: "member", member: "ann" }], fact.id, "dietary-needs");
		expect((await hamkey.ann.request("/api/exposure", { method: "PUT", body: JSON.stringify({ exposure: { "dietary-needs": ["planner"] } }) })).status).toBe(200);
		const dataDir = hamkey.dataDir;
		await hamkey.stop({ keepData: true });
		hamkey = undefined;

		const folders = await crashes.folders(dataDir);
		const first = await crashes.start(
			folders,
			[
				{ call: ["ask", { member: "ann", topic: "dietary-needs", question: "What does Ann eat?" }] },
				{ text: "Ann is vegetarian.", reached: "child", hold: true },
			],
			{ extraBots: [PLANNER] },
		);
		await first.send(ben, "planner", "What should we cook?");
		await first.reached("child");
		await first.kill();

		const records: unknown[] = [];
		hamkey = await startHamkey({ dataDir, extraBots: [PLANNER], recordAsk: (e) => records.push(e) });
		hamkey.faux.setResponses([reply("Ann is vegetarian."), reply("Cook something vegetarian.")]);
		const view: View = await eventually(async () => {
			const v: View = await (await hamkey!.ben.get("/api/bots/planner")).json();
			return !v.busy && v.messages.at(-1)?.role === "assistant" ? v : undefined;
		}, "the Planner to finish");
		expect(view.messages.map((m) => `${m.role}:${m.text}`)).toEqual(["user:What should we cook?", "assistant:Cook something vegetarian."]);
		const log = (await (await hamkey.ben.get("/api/asks")).json()).asks;
		expect(log).toHaveLength(1);
		expect(log[0]).toMatchObject({ outcome: "answered", answer: "Ann is vegetarian." });
		expect(records).toHaveLength(1);
		expect(await hamkey.engine.conversationCount()).toBe(2);
		expect(hamkey.faux.state.callCount).toBe(2);
	});
});

describe("a task parked after repeated crashes", () => {
	it("shows the thread as stuck and finishes after a retry", async () => {
		const folders = await crashes.folders();
		// The replay-safe test tool holds forever, so each restart finds it cut off again.
		let server = await crashes.start(folders, [{ call: ["effect_safe", {}] }], { restartLimit: 2 });
		await server.send(ann, BOT, "Start the long job");
		await toolStarted(async () => (await runs(folders.control, "effect_safe")) === 1);

		// Kill it again and again. Each new process either runs the tool once more (and is cut off) or finds it parked.
		let stuck: View | undefined;
		let kills = 0;
		while (stuck === undefined && kills < 5) {
			await server.kill();
			kills++;
			server = await crashes.start(folders, [{ text: "The job is done." }], { restartLimit: 2 });
			stuck = await eventually(async () => {
				const v = await server.view(ann, BOT);
				if (v.stuck) return v;
				return (await runs(folders.control, "effect_safe")) > kills ? "ran" : undefined;
			}, "the thread to be stuck or to run again").then((found) => (found === "ran" ? undefined : found));
		}
		expect(stuck?.stuck).toBe(true);
		expect(kills).toBe(2);
		// Parked work is not run: the tool ran in the first process and the second, and not in the third.
		expect(await runs(folders.control, "effect_safe")).toBe(2);
		// The view still has the Member's message, and nothing was answered.
		expect(stuck!.messages.map((m) => `${m.role}:${m.text}`)).toEqual(["user:Start the long job"]);

		// Only the Member whose thread it is can retry it, and a thread with nothing parked says so.
		expect((await server.request(ben, `/api/bots/${BOT}/retry`, { method: "POST" })).status).toBe(404);
		expect((await server.request(ben, "/api/bots/primary-ben/retry", { method: "POST" })).status).toBe(409);

		await release(folders.control);
		expect((await server.request(ann, `/api/bots/${BOT}/retry`, { method: "POST" })).status).toBe(202);
		const done = await server.answered(ann, BOT);
		expect(done.messages.at(-1)!.text).toBe("The job is done.");
		expect(done.stuck).toBeUndefined();
		expect(await runs(folders.control, "effect_safe")).toBe(3);
	});
});

describe("human approvals across a restart (ADR 0008)", () => {
	// A Card is a record on disk and a tap is a separate HTTP request, so no tool call waits for a Member and nothing
	// has to survive a crash mid-wait. These tests kill the server with a Card posted and tap it afterwards.

	it("lets a Member approve a sharing Card after a kill, and the Fact is shared", async () => {
		hamkey = await startHamkey();
		const scope = { kind: "member", member: "ann" } as const;
		const fact = await hamkey.memory.saveFact(scope, "Ann is vegetarian");
		const dataDir = hamkey.dataDir;
		await hamkey.stop({ keepData: true });
		hamkey = undefined;

		const folders = await crashes.folders(dataDir);
		const server = await crashes.start(folders, [{ call: ["suggest_sharing", { fact_id: fact.id, topic: "dietary-needs" }] }, { text: "I asked Ann." }]);
		await server.send(ann, BOT, "Share my diet");
		await server.answered(ann, BOT);
		await server.kill();

		hamkey = await startHamkey({ dataDir });
		const waiting = (await (await hamkey.ann.get("/api/cards")).json()).cards;
		expect(waiting).toHaveLength(1);
		expect(waiting[0]).toMatchObject({ type: "approval", status: "waiting" });
		expect((await hamkey.memory.listShared(scope, "dietary-needs")).map((f) => f.text)).toEqual([]);
		const tapped = await hamkey.ann.request(`/api/cards/${waiting[0].id}/actions`, { method: "POST", body: JSON.stringify({ action: "approve" }) });
		expect(tapped.status).toBe(200);
		expect((await hamkey.memory.listShared(scope, "dietary-needs")).map((f) => f.text)).toEqual(["Ann is vegetarian"]);
		expect((await (await hamkey.ann.get("/api/cards")).json()).cards).toEqual([]);
	});

	it("lets a Member pick on a Choice Card after a kill, and the Bot hears the pick", async () => {
		const folders = await crashes.folders();
		const server = await crashes.start(folders, [{ call: ["ask_choice", { question: "Pasta or rice?", options: ["Pasta", "Rice"] }] }, { text: "Pick one above." }]);
		await server.send(ann, BOT, "What for dinner?");
		await server.answered(ann, BOT);
		await server.kill();

		hamkey = await startHamkey({ dataDir: folders.dataDir });
		const card = (await (await hamkey.ann.get("/api/cards")).json()).cards[0];
		expect(card).toMatchObject({ type: "choice", status: "waiting" });
		const seen: string[] = [];
		hamkey.faux.setResponses([(context: { messages: unknown[] }) => (seen.push(JSON.stringify(context.messages)), reply("Pasta it is."))] as never);
		const tapped = await hamkey.ann.request(`/api/cards/${card.id}/actions`, { method: "POST", body: JSON.stringify({ action: "choose", option: 0 }) });
		expect(tapped.status).toBe(200);
		const view = await finished(hamkey);
		expect(view.messages.at(-1)!.text).toBe("Pasta it is.");
		expect(seen).toHaveLength(1);
		expect(seen[0]).toContain("Ann chose: Pasta");
		expect((await (await hamkey.ann.get(`/api/bots/${BOT}`)).json()).cards[0]).toMatchObject({ status: "chosen", choice: 0 });
	});
});
