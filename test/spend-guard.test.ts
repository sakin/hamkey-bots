import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MODEL, loadConfig } from "../src/server/config.ts";
import { type Hamkey, startHamkey } from "./harness.ts";
import { call, say } from "./say.ts";

let hamkey: Hamkey | undefined;
afterEach(async () => {
	await hamkey?.stop();
	hamkey = undefined;
});

const LIMIT_MESSAGE = /today's spending limit/;

/** Waits until the Member's thread shows an error, and returns it. */
async function errorShown(h: Hamkey, text: string, responses: unknown[]) {
	h.faux.setResponses(responses as never);
	const live = h.ann.stream((v) => v.error !== undefined && !v.busy, 10_000);
	await live.ready;
	expect((await h.ann.send(text)).status).toBe(202);
	return (await live).at(-1)!.error!;
}

describe("daily spend guard", () => {
	it("refuses new model work once over the limit, with a plain message, and asks no model", async () => {
		// Each model response costs $0.60 and the day's limit is $1.
		hamkey = await startHamkey({ pricePerResponse: 0.6, dailyLimitUsd: 1 });
		await say(hamkey, hamkey.ann, "First");
		await say(hamkey, hamkey.ann, "Second");
		const asked = hamkey.faux.state.callCount;
		const refused = await hamkey.ann.send("Third");
		expect(refused.status).toBe(429);
		expect((await refused.json()).error).toMatch(LIMIT_MESSAGE);
		expect(hamkey.faux.state.callCount).toBe(asked);
		// The refused message was not queued in the thread.
		const view = await (await hamkey.ann.get("/api/bots/primary-ann")).json();
		expect(view.messages.map((m: { text: string }) => m.text)).not.toContain("Third");
		// The limit is the household's, not one Member's.
		expect((await hamkey.ben.send("Ben too")).status).toBe(429);
	});

	it("stops a run that goes over the limit before its next model request", async () => {
		hamkey = await startHamkey({ pricePerResponse: 0.6, dailyLimitUsd: 1 });
		// The Bot would keep calling tools; the third request is over the limit and never reaches the model.
		const busyWork = Array.from({ length: 5 }, () => call("memory_search", { query: "x" }));
		const error = await errorShown(hamkey, "Look everything up", [...busyWork, fauxAssistantMessage([fauxText("Done.")])]);
		expect(error).toMatch(LIMIT_MESSAGE);
		expect(hamkey.faux.state.callCount).toBe(2);
	});

	it("counts failed attempts toward the limit", async () => {
		hamkey = await startHamkey({ pricePerResponse: 1, dailyLimitUsd: 1 });
		const error = await errorShown(hamkey, "Hello", [fauxAssistantMessage([], { stopReason: "error", errorMessage: "boom" })]);
		expect(error).not.toMatch(LIMIT_MESSAGE);
		expect((await hamkey.ann.send("Again")).status).toBe(429);
	});

	it("counts aborted attempts toward the limit", async () => {
		hamkey = await startHamkey({ pricePerResponse: 1, dailyLimitUsd: 1 });
		await errorShown(hamkey, "Hello", [fauxAssistantMessage([fauxText("Half an ans")], { stopReason: "aborted" })]);
		expect((await hamkey.ann.send("Again")).status).toBe(429);
	});

	it("keeps the day's spend across a restart", async () => {
		hamkey = await startHamkey({ pricePerResponse: 1, dailyLimitUsd: 1 });
		await say(hamkey, hamkey.ann, "Hello");
		const dataDir = hamkey.dataDir;
		await hamkey.stop({ keepData: true });
		expect(JSON.parse(await readFile(join(dataDir, "spend.json"), "utf8"))).toMatchObject({ startTotal: 0 });
		hamkey = await startHamkey({ dataDir, pricePerResponse: 1, dailyLimitUsd: 1 });
		const refused = await hamkey.ann.send("After the restart");
		expect(refused.status).toBe(429);
	});

	it("lets work through while under the limit", async () => {
		hamkey = await startHamkey({ pricePerResponse: 0.1, dailyLimitUsd: 1 });
		for (let i = 0; i < 3; i++) await say(hamkey, hamkey.ann, `Message ${i}`);
		expect((await (await hamkey.ann.get("/api/bots/primary-ann")).json()).error).toBeUndefined();
	});
});

describe("spend settings", () => {
	it("lets the Operator set the daily limit, with a default of $1", () => {
		expect(loadConfig({}).dailyLimitUsd).toBe(1);
		expect(loadConfig({ HAMKEY_DAILY_LIMIT_USD: "2.50" }).dailyLimitUsd).toBe(2.5);
		expect(loadConfig({ HAMKEY_DAILY_LIMIT_USD: "0" }).dailyLimitUsd).toBe(0);
		expect(() => loadConfig({ HAMKEY_DAILY_LIMIT_USD: "lots" })).toThrow(/HAMKEY_DAILY_LIMIT_USD/);
		expect(() => loadConfig({ HAMKEY_DAILY_LIMIT_USD: "-1" })).toThrow(/HAMKEY_DAILY_LIMIT_USD/);
	});

	it("uses the recorded default model unless the Operator names another", () => {
		expect(DEFAULT_MODEL).toBe("deepseek/deepseek-v4.1-flash");
		expect(loadConfig({}).model.modelId).toBe(DEFAULT_MODEL);
		expect(loadConfig({ HAMKEY_MODEL: "openai/gpt-5-mini" }).model.modelId).toBe("openai/gpt-5-mini");
	});
});
