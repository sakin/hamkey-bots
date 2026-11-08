import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { GENERIC_PUSH } from "../src/server/push.ts";
import { type Hamkey, startHamkey } from "./harness.ts";
import { call, say } from "./say.ts";

let hamkey: Hamkey | undefined;
afterEach(async () => {
	await hamkey?.stop();
	hamkey = undefined;
});

type Client = Hamkey["ann"];
const b64 = (bytes: number, fill: number) => Buffer.alloc(bytes, fill).toString("base64url");
const subscription = (name: string) => ({ endpoint: `https://push.example.com/send/${name}`, keys: { p256dh: b64(65, 4), auth: b64(16, 7) } });
const register = (who: Client, body: unknown) => who.request("/api/push/subscriptions", { method: "POST", body: JSON.stringify(body) });
const unregister = (who: Client, endpoint: string) => who.request("/api/push/subscriptions", { method: "DELETE", body: JSON.stringify({ endpoint }) });
const waiting = async (who: Client): Promise<{ id: string }[]> => (await (await who.get("/api/cards")).json()).cards;
const bots = async (who: Client): Promise<{ id: string; waiting: number }[]> => (await (await who.get("/api/bots")).json()).bots;

/** Both Members have a phone registered. */
async function bothSubscribed(h: Hamkey) {
	expect((await register(h.ann, subscription("ann-phone"))).status).toBe(201);
	expect((await register(h.ben, subscription("ben-phone"))).status).toBe(201);
}

const SECRETS = ["ANN-SECRET-FACT-HERON", "QUESTION-TEXT-PELICAN", "OPTION-TEXT-OTTER", "INSTRUCTIONS-MARMOT", "BOTNAME-WOMBAT"];
const PLANNER = { id: "planner", name: "Planner", kind: "household", instructions: "INSTRUCTIONS-MARMOT", tools: ["ask", "ask_choice"] };
const DIARY = { id: "diary", name: "BOTNAME-WOMBAT", kind: "personal", owner: "ann", instructions: "INSTRUCTIONS-MARMOT", tools: ["memory_save", "suggest_sharing", "ask_choice"] };

describe("registering for push", () => {
	it("offers the public key, and keeps the VAPID pair in the data folder with mode 600", async () => {
		hamkey = await startHamkey();
		const { key } = await (await hamkey.ann.get("/api/push/key")).json();
		expect(key).toMatch(/^[A-Za-z0-9_-]{80,}$/);
		const file = join(hamkey.dataDir, "vapid.json");
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		const stored = JSON.parse(await readFile(file, "utf8"));
		expect(stored.publicKey).toBe(key);
		// Made once: a restart serves the same key, or every phone would have to subscribe again.
		const dir = hamkey.dataDir;
		await hamkey.stop({ keepData: true });
		hamkey = await startHamkey({ dataDir: dir });
		expect((await (await hamkey.ben.get("/api/push/key")).json()).key).toBe(key);
	});

	it("stores a valid subscription for the requesting Member and removes it again", async () => {
		hamkey = await startHamkey();
		expect((await register(hamkey.ann, subscription("a"))).status).toBe(201);
		expect(await hamkey.pushService.subscriptionsFor("ann")).toEqual([subscription("a")]);
		expect(await hamkey.pushService.subscriptionsFor("ben")).toEqual([]);
		// Registering the same device twice keeps one.
		await register(hamkey.ann, subscription("a"));
		expect(await hamkey.pushService.subscriptionsFor("ann")).toHaveLength(1);
		expect((await unregister(hamkey.ann, subscription("a").endpoint)).status).toBe(200);
		expect(await hamkey.pushService.subscriptionsFor("ann")).toEqual([]);
	});

	it("never lets one Member register for, or remove, the other's device", async () => {
		hamkey = await startHamkey();
		await register(hamkey.ann, subscription("a"));
		// A member field in the body is ignored; Ben's registration is Ben's.
		await register(hamkey.ben, { ...subscription("b"), member: "ann" });
		expect((await hamkey.pushService.subscriptionsFor("ann")).map((s) => s.endpoint)).toEqual([subscription("a").endpoint]);
		await unregister(hamkey.ben, subscription("a").endpoint);
		expect(await hamkey.pushService.subscriptionsFor("ann")).toHaveLength(1);
		// A phone handed over: the same device registered by Ben moves to Ben.
		await register(hamkey.ben, subscription("a"));
		expect(await hamkey.pushService.subscriptionsFor("ann")).toEqual([]);
		expect(await hamkey.pushService.subscriptionsFor("ben")).toHaveLength(2);
	});

	it("refuses subscriptions of the wrong shape", async () => {
		hamkey = await startHamkey();
		const good = subscription("a");
		const bad: unknown[] = [
			undefined,
			{},
			{ ...good, endpoint: "http://push.example.com/a" },
			{ ...good, endpoint: "https://localhost/a" },
			{ ...good, endpoint: "https://127.0.0.1/a" },
			{ ...good, endpoint: "https://192.168.1.5/a" },
			{ ...good, endpoint: "https://user:pw@push.example.com/a" },
			{ ...good, endpoint: "not a url" },
			{ ...good, endpoint: `https://push.example.com/${"a".repeat(1100)}` },
			{ endpoint: good.endpoint },
			{ endpoint: good.endpoint, keys: { p256dh: good.keys.p256dh } },
			{ endpoint: good.endpoint, keys: { ...good.keys, p256dh: b64(10, 1) } },
			{ endpoint: good.endpoint, keys: { ...good.keys, auth: b64(32, 1) } },
			{ endpoint: good.endpoint, keys: { ...good.keys, auth: "not base64url!" } },
		];
		for (const body of bad) expect((await register(hamkey.ann, body)).status, JSON.stringify(body)).toBe(400);
		expect((await register(hamkey.ann, { ...good, padding: "x".repeat(5000) })).status).toBe(413);
		expect(await hamkey.pushService.subscriptionsFor("ann")).toEqual([]);
	});

	it("keeps at most ten devices for a Member, dropping the oldest", async () => {
		hamkey = await startHamkey();
		for (let i = 0; i < 12; i++) await register(hamkey.ann, subscription(`d${i}`));
		const kept = (await hamkey.pushService.subscriptionsFor("ann")).map((s) => s.endpoint);
		expect(kept).toHaveLength(10);
		expect(kept[0]).toBe(subscription("d2").endpoint);
	});

	it("answers an unknown identity with 403", async () => {
		hamkey = await startHamkey();
		const stranger = hamkey.asTailscale("nobody@example.com");
		expect((await stranger.get("/api/push/key")).status).toBe(403);
		expect((await register(stranger, subscription("a"))).status).toBe(403);
	});
});

describe("when a push is sent", () => {
	it("pushes an Approval Card to its owner only", async () => {
		hamkey = await startHamkey({ extraBots: [DIARY] });
		await bothSubscribed(hamkey);
		await say(hamkey, hamkey.ann, "Remember", [call("memory_save", { fact: SECRETS[0] })], "diary");
		const [fact] = await hamkey.memory.loadSummary([{ kind: "member", member: "ann" }]);
		expect(hamkey.push.sent).toEqual([]);
		await say(hamkey, hamkey.ann, "Share it", [call("suggest_sharing", { fact_id: fact!.id, topic: "dietary-needs" })], "diary");
		await hamkey.pushService.idle();
		expect(hamkey.push.endpoints).toEqual([subscription("ann-phone").endpoint]);
	});

	it("pushes a Choice Card to the one Member of a personal thread, and to both in a shared thread", async () => {
		hamkey = await startHamkey({ extraBots: [PLANNER] });
		await bothSubscribed(hamkey);
		await say(hamkey, hamkey.ann, "Which?", [call("ask_choice", { question: "A or B?", options: ["A", "B"] })]);
		await hamkey.pushService.idle();
		expect(hamkey.push.endpoints).toEqual([subscription("ann-phone").endpoint]);
		hamkey.push.sent.length = 0;
		await say(hamkey, hamkey.ann, "Which night?", [call("ask_choice", { question: "Fri or Sat?", options: ["Fri", "Sat"] })], "planner");
		await hamkey.pushService.idle();
		expect(hamkey.push.endpoints.sort()).toEqual([subscription("ann-phone").endpoint, subscription("ben-phone").endpoint]);
	});

	it("pushes a direct question to the Member who must answer, not to the Member who asked", async () => {
		hamkey = await startHamkey({ extraBots: [PLANNER] });
		await bothSubscribed(hamkey);
		// Ann has shared nothing, so Ben's planner cannot find out and asks Ann directly.
		await say(hamkey, hamkey.ben, "Plan dinner", [call("ask", { member: "ann", topic: "dietary-needs", question: SECRETS[1] })], "planner");
		await hamkey.pushService.idle();
		expect(await waiting(hamkey.ann)).toHaveLength(1);
		expect(hamkey.push.endpoints).toEqual([subscription("ann-phone").endpoint]);
	});

	it("sends nothing about settling a Card", async () => {
		hamkey = await startHamkey();
		await bothSubscribed(hamkey);
		const { view } = await say(hamkey, hamkey.ann, "Which?", [call("ask_choice", { question: "A or B?", options: ["A", "B"] })]);
		await hamkey.pushService.idle();
		const before = hamkey.push.sent.length;
		const card = view.cards[0];
		await hamkey.ann.request(`/api/cards/${card.id}/actions`, { method: "POST", body: JSON.stringify({ action: "choose", option: 0 }) });
		await hamkey.pushService.idle();
		expect(hamkey.push.sent).toHaveLength(before);
	});

	it("sends the same generic text every time, with none of the private content", async () => {
		hamkey = await startHamkey({ extraBots: [PLANNER, DIARY] });
		await bothSubscribed(hamkey);
		await say(hamkey, hamkey.ann, "Remember", [call("memory_save", { fact: SECRETS[0] })], "diary");
		const [fact] = await hamkey.memory.loadSummary([{ kind: "member", member: "ann" }]);
		await say(hamkey, hamkey.ann, "Share", [call("suggest_sharing", { fact_id: fact!.id, topic: "dietary-needs" })], "diary");
		await say(hamkey, hamkey.ann, "Choose", [call("ask_choice", { question: SECRETS[1], options: [SECRETS[2], "Other"] })], "diary");
		await say(hamkey, hamkey.ben, "Plan", [call("ask", { member: "ann", topic: "dietary-needs", question: SECRETS[1] })], "planner");
		await hamkey.pushService.idle();
		expect(hamkey.push.sent.length).toBeGreaterThanOrEqual(3);
		for (const { payload } of hamkey.push.sent) expect(payload).toEqual(GENERIC_PUSH);
		expect(GENERIC_PUSH).toEqual({ title: "Hamkey", body: "A Bot needs you", url: "/" });
		const everything = JSON.stringify(hamkey.push.sent);
		for (const secret of SECRETS) expect(everything).not.toContain(secret);
	});

	it("sends no push for ordinary replies, in a personal or a shared thread", async () => {
		hamkey = await startHamkey({ extraBots: [PLANNER] });
		await bothSubscribed(hamkey);
		await say(hamkey, hamkey.ann, "Hello", [fauxAssistantMessage([fauxText("Hi Ann")])]);
		await say(hamkey, hamkey.ben, "Hello planner", [fauxAssistantMessage([fauxText("Hi Ben")])], "planner");
		await say(hamkey, hamkey.ann, "Hello again", [fauxAssistantMessage([fauxText("Hi Ann")])], "planner");
		await hamkey.pushService.idle();
		expect(hamkey.push.sent).toEqual([]);
	});

	it("sends one push per Card, and a rerun of the same Card or a restart sends none", async () => {
		hamkey = await startHamkey();
		await bothSubscribed(hamkey);
		const made = { id: "card-1", type: "choice" as const, thread: "1", botId: "primary-ann", addressees: ["ann"], fields: { question: "A or B?", options: ["A", "B"] } };
		await hamkey.cards.create(made);
		await hamkey.cards.create(made);
		await hamkey.pushService.idle();
		expect(hamkey.push.sent).toHaveLength(1);
		const dir = hamkey.dataDir;
		await hamkey.stop({ keepData: true });
		hamkey = await startHamkey({ dataDir: dir });
		await hamkey.cards.create(made);
		await hamkey.pushService.idle();
		expect(hamkey.push.sent).toEqual([]);
		// Subscriptions survive the restart, so a new Card still reaches Ann.
		await hamkey.cards.create({ ...made, id: "card-2" });
		await hamkey.pushService.idle();
		expect(hamkey.push.endpoints).toEqual([subscription("ann-phone").endpoint]);
	});

	it("drops a subscription the push service says is gone, and keeps one that merely failed", async () => {
		hamkey = await startHamkey();
		await register(hamkey.ann, subscription("old"));
		await register(hamkey.ann, subscription("flaky"));
		await register(hamkey.ann, subscription("fine"));
		hamkey.push.answer = (s) => (s.endpoint.endsWith("/old") ? "gone" : s.endpoint.endsWith("/flaky") ? "failed" : "ok");
		await hamkey.cards.create({ id: "c1", type: "choice", thread: "1", botId: "primary-ann", addressees: ["ann"], fields: { question: "A or B?", options: ["A", "B"] } });
		await hamkey.pushService.idle();
		expect((await hamkey.pushService.subscriptionsFor("ann")).map((s) => s.endpoint.split("/").at(-1))).toEqual(["flaky", "fine"]);
	});

	it("does not let a sender that throws break the Card", async () => {
		hamkey = await startHamkey({
			push: {
				send: async () => {
					throw new Error("network down");
				},
			},
		});
		await register(hamkey.ann, subscription("a"));
		const { view } = await say(hamkey, hamkey.ann, "Which?", [call("ask_choice", { question: "A or B?", options: ["A", "B"] })]);
		await hamkey.pushService.idle();
		expect(view.cards).toHaveLength(1);
		expect(await hamkey.pushService.subscriptionsFor("ann")).toHaveLength(1);
	});
});

describe("badges", () => {
	it("counts, per Bot, the Cards waiting for the requesting Member, and updates as they are made and settled", async () => {
		hamkey = await startHamkey({ extraBots: [PLANNER] });
		const counts = async (who: Client) => Object.fromEntries((await bots(who)).map((b) => [b.id, b.waiting]));
		expect(await counts(hamkey.ann)).toMatchObject({ "primary-ann": 0, planner: 0 });
		await say(hamkey, hamkey.ann, "Which?", [call("ask_choice", { question: "A or B?", options: ["A", "B"] })]);
		const { view } = await say(hamkey, hamkey.ann, "Which night?", [call("ask_choice", { question: "Fri or Sat?", options: ["Fri", "Sat"] })], "planner");
		await say(hamkey, hamkey.ben, "Plan", [call("ask", { member: "ann", topic: "dietary-needs", question: "Anything?" })], "planner");
		expect(await counts(hamkey.ann)).toMatchObject({ "primary-ann": 1, planner: 2 });
		// Ben sees the shared Choice Card but not Ann's private Card or the question meant for Ann.
		expect(await counts(hamkey.ben)).toMatchObject({ "primary-ben": 0, planner: 1 });
		expect(Object.keys(await counts(hamkey.ben))).not.toContain("primary-ann");
		await hamkey.ann.request(`/api/cards/${view.cards[0].id}/actions`, { method: "POST", body: JSON.stringify({ action: "choose", option: 0 }) });
		expect(await counts(hamkey.ann)).toMatchObject({ planner: 1 });
		expect(await counts(hamkey.ben)).toMatchObject({ planner: 0 });
	});
});

describe("installing to a home screen", () => {
	it("builds the app with a manifest, icons and a service worker that the server serves with the right content types", async () => {
		const out = await mkdtemp(join(tmpdir(), "hamkey-build-"));
		try {
			// Vitest runs with NODE_ENV=test, which Vite treats as development (no service worker registration).
			const env = process.env.NODE_ENV;
			process.env.NODE_ENV = "production";
			try {
				await build({ configFile: new URL("../vite.config.ts", import.meta.url).pathname, logLevel: "silent", mode: "production", build: { outDir: out, emptyOutDir: true } });
			} finally {
				process.env.NODE_ENV = env;
			}
			hamkey = await startHamkey({ webDir: out });
			const fetchFile = (path: string) => fetch(`http://127.0.0.1:${hamkey!.port}${path}`);

			const html = await (await fetchFile("/")).text();
			expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest"');
			expect(html).toContain('rel="apple-touch-icon"');
			expect(html).toContain('name="apple-mobile-web-app-capable"');

			const manifestResponse = await fetchFile("/manifest.webmanifest");
			expect(manifestResponse.headers.get("content-type")).toMatch(/^application\/(manifest\+json|json)/);
			const manifest = await manifestResponse.json();
			expect(manifest).toMatchObject({ name: "Hamkey", start_url: "/", display: "standalone" });
			expect(manifest.short_name).toBeTruthy();
			expect(manifest.theme_color).toMatch(/^#/);
			expect(manifest.background_color).toMatch(/^#/);
			const icons = manifest.icons as { src: string; sizes: string; type: string; purpose: string }[];
			expect(icons.map((i) => `${i.sizes} ${i.purpose}`).sort()).toEqual(["192x192 any", "512x512 any", "512x512 maskable"]);
			for (const icon of [...icons, { src: "/apple-touch-icon.png" }]) {
				const response = await fetchFile(icon.src);
				expect(response.status, icon.src).toBe(200);
				expect(response.headers.get("content-type")).toBe("image/png");
				expect(Buffer.from(await response.arrayBuffer()).subarray(1, 4).toString()).toBe("PNG");
			}

			const worker = await fetchFile("/sw.js");
			expect(worker.status).toBe(200);
			expect(worker.headers.get("content-type")).toMatch(/javascript/);
			const source = await worker.text();
			expect(source).toContain('addEventListener("push"');
			expect(source).toContain('addEventListener("notificationclick"');
			// The worker caches no app or API data.
			expect(source).not.toMatch(/caches\.|addEventListener\("fetch"/);
			// The app registers it.
			const scripts = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1]!);
			const sources = await Promise.all(scripts.map(async (path) => (await fetchFile(path)).text()));
			expect(sources.some((code) => code.includes("serviceWorker") && code.includes("/sw.js"))).toBe(true);
		} finally {
			await hamkey?.stop();
			hamkey = undefined;
			await rm(out, { recursive: true, force: true });
		}
	}, 90_000);
});
