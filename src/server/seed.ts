import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Where Hamkey's Seeded Bots live in the repository. Each is a Bot file like any other (GLOSSARY: Seeded Bot). */
export const SEEDS_DIR = fileURLToPath(new URL("../../seeds/bots", import.meta.url));

/**
 * Gives the data folder the Bots Hamkey ships, once each. A seed is copied only if its id has never been seeded here,
 * and the ids are then recorded in `seeded.json`, so a Member who deletes a seeded Bot does not get it back on the next
 * start. A file that already exists is never overwritten, whether a Member edited it or put it there by hand; it
 * simply counts as seeded. After this the Bot is an ordinary file the Members own.
 * Returns the ids copied this time.
 */
export async function seedBots(dataDir: string, seeds = SEEDS_DIR): Promise<string[]> {
	const seededFile = join(dataDir, "seeded.json");
	let seeded: string[] = [];
	try {
		seeded = JSON.parse(await readFile(seededFile, "utf8"));
		if (!Array.isArray(seeded) || !seeded.every((id) => typeof id === "string")) throw new Error("expected a list of Bot ids");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`${seededFile} is not a list of Bot ids: ${(error as Error).message}`);
		seeded = [];
	}
	const files = (await readdir(seeds)).filter((f) => f.endsWith(".json")).sort();
	const copied: string[] = [];
	const known = new Set(seeded);
	await mkdir(join(dataDir, "bots"), { recursive: true });
	for (const file of files) {
		const id = file.replace(/\.json$/, "");
		if (known.has(id)) continue;
		try {
			// "wx" fails if the file exists, so an existing Bot is never overwritten.
			await writeFile(join(dataDir, "bots", file), await readFile(join(seeds, file), "utf8"), { flag: "wx" });
			copied.push(id);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		known.add(id);
	}
	if (known.size !== seeded.length) await writeFile(seededFile, JSON.stringify([...known].sort(), null, "\t") + "\n");
	return copied;
}
