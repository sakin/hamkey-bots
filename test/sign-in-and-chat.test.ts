import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.ts";
import { type Hamkey, startHamkey } from "./harness.ts";

let hamkey: Hamkey | undefined;
afterEach(async () => {
	await hamkey?.stop();
	hamkey = undefined;
});

describe("identity", () => {
	it("recognises each Member from their Tailscale identity", async () => {
		hamkey = await startHamkey();
		const ann = await (await hamkey.ann.get("/api/me")).json();
		const ben = await (await hamkey.ben.get("/api/me")).json();
		expect(ann.member).toEqual({ id: "ann", name: "Ann" });
		expect(ben.member).toEqual({ id: "ben", name: "Ben" });
	});

	it("refuses an unknown identity and a request with none", async () => {
		hamkey = await startHamkey();
		const stranger = hamkey.asTailscale("mallory@example.com");
		for (const path of ["/api/me", "/api/primary"]) expect((await stranger.get(path)).status).toBe(403);
		expect((await stranger.send("hi")).status).toBe(403);
		expect((await hamkey.as({}).get("/api/me")).status).toBe(403);
	});

	it("listens only on localhost", async () => {
		hamkey = await startHamkey();
		expect(hamkey.server.address()).toMatchObject({ address: "127.0.0.1" });
	});

	it("lets the Operator act as either Member with a development identity", async () => {
		hamkey = await startHamkey({ devIdentity: "ann" });
		const none = hamkey.as({});
		expect((await (await none.get("/api/me")).json()).member.id).toBe("ann");
		const asBen = hamkey.as({ "x-hamkey-dev-member": "ben" });
		expect((await (await asBen.get("/api/me")).json()).member.id).toBe("ben");
		expect((await hamkey.as({ "x-hamkey-dev-member": "eve" }).get("/api/me")).status).toBe(403);
	});

	it("ignores the development header when no development identity is set", async () => {
		hamkey = await startHamkey();
		expect((await hamkey.as({ "x-hamkey-dev-member": "ann" }).get("/api/me")).status).toBe(403);
	});

	it("refuses to start with a development identity in production", () => {
		expect(() => loadConfig({ NODE_ENV: "production", HAMKEY_DEV_IDENTITY: "ann" })).toThrow(/development/);
		expect(() => loadConfig({ HAMKEY_DEV_IDENTITY: "ann" })).toThrow(/development/);
		expect(loadConfig({ NODE_ENV: "development", HAMKEY_DEV_IDENTITY: "ann" }).devIdentity).toBe("ann");
	});
});

describe("chatting with a Primary Bot", () => {
	it("streams the Bot's reply to the Member who asked", async () => {
		hamkey = await startHamkey();
		hamkey.faux.setResponses([fauxAssistantMessage([fauxText("Hello Ann, how can I help with the household today?")])]);
		const live = hamkey.ann.stream((v) => v.messages.some((m) => m.role === "assistant"));
		await new Promise((r) => setTimeout(r, 50));
		expect((await hamkey.ann.send("Hi there")).status).toBe(202);
		const views = await live;
		const last = views.at(-1)!;
		expect(last.messages.map((m) => [m.role, m.text])).toEqual([
			["user", "Hi there"],
			["assistant", "Hello Ann, how can I help with the household today?"],
		]);
		// The reply arrived through committed views, and the thread ends idle.
		expect(views.length).toBeGreaterThan(2);
		expect((await (await hamkey.ann.get("/api/primary")).json()).busy).toBe(false);
	});

	it("keeps each Member's conversation to themselves", async () => {
		hamkey = await startHamkey();
		hamkey.faux.setResponses([fauxAssistantMessage([fauxText("Noted.")])]);
		const live = hamkey.ann.stream((v) => v.messages.some((m) => m.role === "assistant"));
		await new Promise((r) => setTimeout(r, 50));
		await hamkey.ann.send("A secret only Ann knows");
		await live;
		const ben = await (await hamkey.ben.get("/api/primary")).json();
		expect(ben.messages).toEqual([]);
		expect(JSON.stringify(ben)).not.toContain("secret");
	});

	it("rejects an empty message", async () => {
		hamkey = await startHamkey();
		expect((await hamkey.ann.send("   ")).status).toBe(400);
	});

	it("does not send the same message twice when a request is retried", async () => {
		hamkey = await startHamkey();
		hamkey.faux.setResponses([fauxAssistantMessage([fauxText("Once.")])]);
		const live = hamkey.ann.stream((v) => v.messages.some((m) => m.role === "assistant"));
		await new Promise((r) => setTimeout(r, 50));
		await hamkey.ann.send("Hello", "req-1");
		await hamkey.ann.send("Hello", "req-1");
		const views = await live;
		expect(views.at(-1)!.messages.filter((m) => m.role === "user")).toHaveLength(1);
	});

	it("tells the Member when the Bot could not answer", async () => {
		hamkey = await startHamkey();
		hamkey.faux.setResponses([]);
		const live = hamkey.ann.stream((v) => v.error !== undefined, 15000);
		await new Promise((r) => setTimeout(r, 50));
		await hamkey.ann.send("Anyone there?");
		expect((await live).at(-1)!.error).toBeTruthy();
	}, 20000);
});

describe("data folder", () => {
	it("keeps application data in the configured folder", async () => {
		hamkey = await startHamkey();
		await hamkey.ann.get("/api/primary");
		expect(existsSync(join(hamkey.dataDir, "hamkey.sqlite"))).toBe(true);
		expect(existsSync(join(hamkey.dataDir, "threads.json"))).toBe(true);
	});
});

describe("routing", () => {
	it("answers an unknown API path with a JSON 404, not the web app", async () => {
		const webDir = await mkdtemp(join(tmpdir(), "hamkey-web-"));
		await writeFile(join(webDir, "index.html"), "<h1>app</h1>");
		hamkey = await startHamkey({ webDir });
		const missing = await hamkey.ann.get("/api/zzz");
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({ error: "Not found" });
		const page = await fetch(`http://127.0.0.1:${hamkey.port}/some/screen`);
		expect(await page.text()).toContain("<h1>app</h1>");
	});

	it("rejects invalid JSON and oversized messages", async () => {
		hamkey = await startHamkey();
		const invalid = await fetch(`http://127.0.0.1:${hamkey.port}/api/primary/messages`, {
			method: "POST",
			headers: { "tailscale-user-login": "ann@example.com", "content-type": "application/json" },
			body: "{nope",
		});
		expect(invalid.status).toBe(400);
		expect((await hamkey.ann.send("x".repeat(40_000))).status).toBe(413);
	});

	it("keeps serving after a client drops its stream", async () => {
		hamkey = await startHamkey();
		const controller = new AbortController();
		const response = await fetch(`http://127.0.0.1:${hamkey.port}/api/primary/events`, {
			headers: { "tailscale-user-login": "ann@example.com" },
			signal: controller.signal,
		});
		await response.body!.getReader().read();
		controller.abort();
		await new Promise((r) => setTimeout(r, 50));
		expect((await hamkey.ann.get("/api/primary")).status).toBe(200);
	});
});
