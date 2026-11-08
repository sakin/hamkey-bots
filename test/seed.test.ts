import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadBots } from "../src/server/bots.ts";
import { seedBots, SEEDS_DIR } from "../src/server/seed.ts";
import { ann, ben } from "./harness.ts";

const dirs: string[] = [];
const temp = async () => {
	const dir = await mkdtemp(join(tmpdir(), "hamkey-seed-"));
	dirs.push(dir);
	return dir;
};
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const exists = (path: string) => readFile(path, "utf8").then(() => true, () => false);

describe("Seeded Bots", () => {
	it("are copied into a fresh data folder, and load as ordinary Bots", async () => {
		const dir = await temp();
		expect(await seedBots(dir)).toContain("meal-planner");
		const bots = await loadBots(dir, [ann, ben]);
		expect(bots.find((b) => b.id === "meal-planner")).toMatchObject({ kind: "household", name: "Meal Planner" });
		expect(JSON.parse(await readFile(join(dir, "seeded.json"), "utf8"))).toContain("meal-planner");
		// What ships is valid on its own, whatever the data folder holds.
		expect(await exists(join(SEEDS_DIR, "meal-planner.json"))).toBe(true);
	});

	it("never overwrite a file that is already there, and count it as seeded", async () => {
		const dir = await temp();
		await mkdir(join(dir, "bots"));
		const edited = JSON.stringify({ id: "meal-planner", name: "Chef", kind: "household", instructions: "My own words." });
		await writeFile(join(dir, "bots", "meal-planner.json"), edited);
		expect(await seedBots(dir)).toEqual([]);
		expect(await readFile(join(dir, "bots", "meal-planner.json"), "utf8")).toBe(edited);
		expect(JSON.parse(await readFile(join(dir, "seeded.json"), "utf8"))).toContain("meal-planner");
	});

	it("are not brought back once a Member has deleted them, nor reset after an edit", async () => {
		const dir = await temp();
		await seedBots(dir);
		const file = join(dir, "bots", "meal-planner.json");
		await rm(file);
		expect(await seedBots(dir)).toEqual([]);
		expect(await exists(file)).toBe(false);
		// A later start with an edited copy leaves it alone, too.
		await writeFile(file, "edited");
		await seedBots(dir);
		expect(await readFile(file, "utf8")).toBe("edited");
	});

	it("add a Bot that ships later, without touching the earlier ones", async () => {
		const dir = await temp();
		const seeds = await temp();
		await writeFile(join(seeds, "one.json"), "1");
		expect(await seedBots(dir, seeds)).toEqual(["one"]);
		await writeFile(join(dir, "bots", "one.json"), "edited");
		await writeFile(join(seeds, "two.json"), "2");
		expect(await seedBots(dir, seeds)).toEqual(["two"]);
		expect(await readFile(join(dir, "bots", "one.json"), "utf8")).toBe("edited");
		expect(JSON.parse(await readFile(join(dir, "seeded.json"), "utf8"))).toEqual(["one", "two"]);
	});
});
