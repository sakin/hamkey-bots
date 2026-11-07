import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DailySpend } from "../src/server/spend.ts";

/** A running total the test moves by hand, as Pi's usage totals move when Bots answer. */
function fakeTotals(start = 0) {
	let total = start;
	return { read: async () => total, add: (cost: number) => (total += cost) };
}

const at = (iso: string) => () => new Date(iso);

describe("daily spend", () => {
	it("is worked out from the running total, as what was spent since the day began", async () => {
		const dir = await mkdtemp(join(tmpdir(), "hamkey-spend-"));
		const totals = fakeTotals(5);
		const spend = new DailySpend({ dataDir: dir, limitUsd: 1, total: totals.read, now: at("2026-11-07T09:00:00") });
		expect(await spend.today()).toBe(0);
		totals.add(0.25);
		totals.add(0.5);
		expect(await spend.today()).toBeCloseTo(0.75);
		expect(await spend.refusal()).toBeUndefined();
	});

	it("refuses once today's spend reaches the limit", async () => {
		const dir = await mkdtemp(join(tmpdir(), "hamkey-spend-"));
		const totals = fakeTotals();
		const spend = new DailySpend({ dataDir: dir, limitUsd: 1, total: totals.read, now: at("2026-11-07T09:00:00") });
		await spend.today();
		totals.add(1);
		expect(await spend.refusal()).toMatch(/today's spending limit/);
	});

	it("starts each day from nothing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "hamkey-spend-"));
		const totals = fakeTotals();
		let now = new Date("2026-11-07T23:00:00");
		const spend = new DailySpend({ dataDir: dir, limitUsd: 1, total: totals.read, now: () => now });
		await spend.today();
		totals.add(2);
		expect(await spend.refusal()).toBeDefined();
		now = new Date("2026-11-08T00:01:00");
		expect(await spend.today()).toBe(0);
		expect(await spend.refusal()).toBeUndefined();
	});

	it("survives a restart: a new instance on the same data folder keeps the day's start", async () => {
		const dir = await mkdtemp(join(tmpdir(), "hamkey-spend-"));
		const totals = fakeTotals(3);
		const options = { dataDir: dir, limitUsd: 1, total: totals.read, now: at("2026-11-07T09:00:00") };
		await new DailySpend(options).today();
		totals.add(1.5);
		const restarted = new DailySpend(options);
		expect(await restarted.today()).toBeCloseTo(1.5);
		expect(await restarted.refusal()).toBeDefined();
	});

	it("starts again from the current total if the total ever goes down", async () => {
		const dir = await mkdtemp(join(tmpdir(), "hamkey-spend-"));
		// The Operator replaced the conversation store: its totals start again from nothing.
		await writeFile(join(dir, "spend.json"), JSON.stringify({ day: "2026-11-07", startTotal: 10 }));
		const spend = new DailySpend({ dataDir: dir, limitUsd: 1, total: async () => 0.2, now: at("2026-11-07T09:00:00") });
		expect(await spend.today()).toBe(0);
	});

	it("refuses everything with a limit of zero", async () => {
		const dir = await mkdtemp(join(tmpdir(), "hamkey-spend-"));
		const spend = new DailySpend({ dataDir: dir, limitUsd: 0, total: async () => 0, now: at("2026-11-07T09:00:00") });
		expect(await spend.refusal()).toBeDefined();
	});
});
