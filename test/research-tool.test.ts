import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { FakeWeb, INJECTION } from "./fake-web.ts";
import { type Hamkey, startHamkey } from "./harness.ts";
import { call } from "./say.ts";

let hamkey: Hamkey | undefined;
afterEach(async () => {
	await hamkey?.stop();
	hamkey = undefined;
});

const GIFTS = "https://shop.example/gifts";
const PELICAN = "CALLER-THREAD-PELICAN";
const HERON = "CALLER-INSTRUCTIONS-HERON";
const USES = { id: "scout", name: "Scout", kind: "household", instructions: HERON, tools: ["memory_save", "memory_search", "research"] };
const WITHOUT = { id: "plain", name: "Plain", kind: "household", instructions: "Plain bot.", tools: ["memory_save"] };

const web = () =>
	new FakeWeb()
		.onSearch("gifts", [{ url: GIFTS, title: "Gift ideas", snippet: "Good gifts" }, { url: "https://blog.example/tea", title: "Tea", snippet: "x" }])
		.onSearch("bikes", [{ url: "https://bikes.example/", title: "Bikes", snippet: "Two wheels" }])
		.onPage(GIFTS, { title: "Gift ideas", text: "A tea set is a nice gift." })
		.onPage("https://blog.example/tea", { text: INJECTION })
		.onPage("https://bikes.example/", { text: "Bikes are fast." });

type Seen = { system: string; messages: string; tools: string[] };

/** Scripts the model one response per request, recording everything it was shown, then sends and waits for the Bot to finish. */
async function ask(h: Hamkey, bot: string, text: string, steps: unknown[], who: Hamkey["ann"] = h.ann) {
	const seen: Seen[] = [];
	type Sys = { role: string; toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] };
	const record = (message: unknown) => (context: { messages: Sys[] }) => {
		// Pi carries the system prompt and tool definitions in system messages; the offered tools are those added and not removed.
		const offered = new Set<string>();
		for (const m of context.messages) if (m.role === "system") {
			for (const t of m.toolsAdded ?? []) offered.add(t.name);
			for (const t of m.toolsRemoved ?? []) offered.delete(t.name);
		}
		seen.push({ system: "", messages: JSON.stringify(context.messages), tools: [...offered] });
		return message as ReturnType<typeof fauxAssistantMessage>;
	};
	h.faux.setResponses([...steps.map(record), ...Array.from({ length: 4 }, () => record(fauxAssistantMessage([fauxText("Done.")])))] as never);
	expect((await who.send(text, undefined, bot)).status).toBe(202);
	let view: { messages: { role: string; text: string }[]; busy: boolean; error?: string } = { messages: [], busy: true };
	for (let i = 0; i < 300; i++) {
		view = await (await who.get(`/api/bots/${bot}`)).json();
		if (!view.busy && view.messages.some((m) => m.text === text) && (view.messages.at(-1)!.role === "assistant" || view.error !== undefined)) break;
		await new Promise((r) => setTimeout(r, 25));
	}
	return { seen, view };
}

const reply = (t: string) => fauxAssistantMessage([fauxText(t)]);
const research = (request: string) => call("research", { request });
/** A full lookup by the Research Bot: search, open, answer. */
const lookup = (answer: string) => [call("web_search", { query: "gifts" }), call("web_open", { url: GIFTS }), reply(answer)];

describe("the research tool", () => {
	it("can be ticked in the Bot editor and a Bot file, and is not on by default", async () => {
		hamkey = await startHamkey();
		const catalog = await (await hamkey.ann.get("/api/models")).json();
		expect(catalog.tools).toContain("research");
		expect(catalog.defaultTools).not.toContain("research");
		const made = await (await hamkey.ann.request("/api/bots", { method: "POST", body: JSON.stringify({ name: "Looker", instructions: "Look.", kind: "personal", tools: ["research"] }) })).json();
		const def = await (await hamkey.ann.get(`/api/bots/${made.id}/definition`)).json();
		expect(def.tools).toEqual(["research"]);
		const plain = await (await hamkey.ann.request("/api/bots", { method: "POST", body: JSON.stringify({ name: "Plain two", instructions: "x", kind: "personal" }) })).json();
		expect((await (await hamkey.ann.get(`/api/bots/${plain.id}/definition`)).json()).tools).not.toContain("research");
	});

	it("gives a Household Bot web research through the Research Bot, marked untrusted, and nothing else on the web", async () => {
		const fake = web();
		hamkey = await startHamkey({ extraBots: [USES], web: fake });
		const { seen, view } = await ask(hamkey, "scout", "Find a gift", [research("gift ideas for tea lovers"), ...lookup("Try a tea set (shop.example/gifts)."), reply("I found a tea set.")]);
		expect(fake.searches).toEqual(["gifts"]);
		expect(fake.opened).toEqual([GIFTS]);
		// The caller got the answer wrapped as untrusted and from the Research Bot.
		const final = seen.at(-1)!.messages;
		expect(final).toContain("Try a tea set");
		expect(final).toContain("untrusted text from the web");
		expect(final).toContain('<untrusted source=\\"Research Bot\\">');
		expect(view.messages.at(-1)!.text).toBe("I found a tea set.");
		// The caller's own thread does not hold the child's pages or searches.
		expect(JSON.stringify(view)).not.toContain("A tea set is a nice gift.");
	});

	it("works for a Personal Bot too", async () => {
		const fake = web();
		hamkey = await startHamkey({ web: fake });
		const made = await (await hamkey.ann.request("/api/bots", { method: "POST", body: JSON.stringify({ name: "Looker", instructions: "Look.", kind: "personal", tools: ["research"] }) })).json();
		const { seen } = await ask(hamkey, made.id, "Gifts?", [research("gifts"), ...lookup("A tea set."), reply("Done.")]);
		expect(fake.opened).toEqual([GIFTS]);
		expect(seen.at(-1)!.messages).toContain("A tea set.");
	});

	it("shows the child none of the caller's tools, thread or instructions, only the Research Bot's", async () => {
		hamkey = await startHamkey({ extraBots: [USES], web: web() });
		await ask(hamkey, "scout", `Earlier I said ${PELICAN}`, []);
		const { seen } = await ask(hamkey, "scout", "Please look into gifts", [research("gift ideas"), ...lookup("A tea set."), reply("Done.")]);
		const [caller, ...child] = [seen[0]!, seen[1]!, seen[2]!, seen[3]!];
		// Sanity: the caller sees its own things, including the research tool.
		expect(caller.system + caller.messages).toContain(HERON);
		expect(caller.messages).toContain(PELICAN);
		expect(caller.tools).toEqual(expect.arrayContaining(["research", "memory_save", "memory_search"]));
		for (const request of child) {
			const shown = request.system + request.messages;
			expect(shown).not.toContain(HERON);
			expect(shown).not.toContain(PELICAN);
			expect(shown).not.toContain("Please look into gifts");
			expect(shown).not.toContain("Earlier I said");
			expect(shown).toContain("You are the Research Bot");
			expect(shown).toContain("gift ideas");
			// Not shown the caller's shape either: no memory section, no shared-thread note.
			expect(shown).not.toContain("shared by both Members");
			expect(shown).not.toContain("What you remember");
			expect(request.tools.sort()).toEqual(["web_open", "web_search"]);
		}
	});

	it("runs each request in a fresh conversation: nothing of the first reaches the second", async () => {
		const fake = web();
		hamkey = await startHamkey({ extraBots: [USES], web: fake });
		const { seen } = await ask(hamkey, "scout", "Two lookups", [
			research("FIRST-REQUEST-KITE"), ...lookup("FIRST-ANSWER-OTTER"),
			research("SECOND-REQUEST-MOOSE"), call("web_search", { query: "bikes" }), reply("SECOND-ANSWER"),
			reply("Done."),
		]);
		// Requests: caller, then 3 child, caller, then 2 child, caller.
		const second = [seen[5]!, seen[6]!].map((s) => s.system + s.messages).join();
		expect(second).toContain("SECOND-REQUEST-MOOSE");
		expect(second).not.toContain("FIRST-REQUEST-KITE");
		expect(second).not.toContain("FIRST-ANSWER-OTTER");
		expect(second).not.toContain("A tea set is a nice gift.");
		// Each child had its own allowed links: the first search's link is not open to the second request.
		const again = await ask(hamkey, "scout", "Third", [research("sneaky"), call("web_open", { url: GIFTS }), reply("nope"), reply("Done.")]);
		expect(fake.opened).toEqual([GIFTS]);
		expect(again.seen[2]!.messages).toContain("You can only open links from your own search results.");
	});

	it("keeps web_open limited to the child's own search results", async () => {
		const fake = web();
		hamkey = await startHamkey({ extraBots: [USES], web: fake });
		await ask(hamkey, "scout", "Go", [research("x"), call("web_open", { url: GIFTS }), call("web_search", { query: "bikes" }), call("web_open", { url: GIFTS }), reply("done"), reply("ok")]);
		expect(fake.opened).toEqual([]);
	});

	it("does nothing for a Bot without the tool", async () => {
		const fake = web();
		hamkey = await startHamkey({ extraBots: [WITHOUT], web: fake });
		const { seen } = await ask(hamkey, "plain", "Look up gifts", [research("gifts"), reply("Done.")]);
		expect(seen[0]!.tools).not.toContain("research");
		expect(fake.searches).toEqual([]);
		expect(fake.opened).toEqual([]);
		// Only the caller's own two requests were made: no child conversation asked a model.
		expect(seen.slice(0, 2)).toHaveLength(2);
		expect(seen[1]!.messages).toContain("not available");
		expect(hamkey.faux.state.callCount).toBe(2);
		// Nor does the Research Bot's own thread have the tool.
		const own = await ask(hamkey, "research", "Hi", [research("nested"), reply("ok")]);
		expect(own.seen[0]!.tools.sort()).toEqual(["web_open", "web_search"]);
		expect(own.seen[1]!.messages).toContain("not available");
		expect(hamkey.faux.state.callCount).toBe(4);
	});

	it("never offers the Research Bot its own thread the research tool", async () => {
		hamkey = await startHamkey({ extraBots: [USES], web: web() });
		const list = await (await hamkey.ann.get("/api/bots")).json();
		expect(list.bots.find((b: { id: string }) => b.id === "research").editable).toBe(false);
		// The Research Bot's tools are fixed: even as a direct thread it only offers web tools (covered above).
		const { seen } = await ask(hamkey, "research", "Hi", []);
		expect(seen[0]!.tools).not.toContain("research");
	});

	it("tells the caller plainly when the research fails, without crashing", async () => {
		const fake = web();
		hamkey = await startHamkey({ extraBots: [USES], web: fake });
		const failure = fauxAssistantMessage([], { stopReason: "error", errorMessage: "boom" });
		const { seen, view } = await ask(hamkey, "scout", "Look it up", [research("gifts"), failure, reply("Sorry, I could not look that up.")]);
		expect(seen.at(-1)!.messages).toContain("The Research Bot could not answer");
		expect(view.messages.at(-1)!.text).toBe("Sorry, I could not look that up.");
	});

	it("spends through the gate: a child's model requests count toward the daily limit", async () => {
		const fake = web();
		// Each response costs $0.60 and the limit is $1: the caller's request and the child's first fit, the child's second does not.
		hamkey = await startHamkey({ extraBots: [USES], web: fake, pricePerResponse: 0.6, dailyLimitUsd: 1 });
		const { view } = await ask(hamkey, "scout", "Look it up", [research("gifts"), call("web_search", { query: "gifts" }), ...lookup("never")]);
		expect(hamkey.faux.state.callCount).toBe(2);
		expect(fake.searches).toEqual(["gifts"]);
		expect(fake.opened).toEqual([]);
		expect(view.error).toMatch(/today's spending limit/);
	});
});
