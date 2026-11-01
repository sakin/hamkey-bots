import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type Member = { id: string; name: string; tailscaleLogin: string };

/** The household's two Members, read from `members.json` in the data folder. */
export async function loadMembers(dataDir: string): Promise<Member[]> {
	let raw: string;
	try {
		raw = await readFile(join(dataDir, "members.json"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(`Missing ${join(dataDir, "members.json")}: list the two Members as [{id, name, tailscaleLogin}].`);
		}
		throw error;
	}
	const members = JSON.parse(raw) as Member[];
	if (!Array.isArray(members) || members.length !== 2) throw new Error("members.json must list exactly two Members.");
	for (const m of members) {
		if (!m.id || !m.name || !m.tailscaleLogin) throw new Error("Each Member needs id, name and tailscaleLogin.");
	}
	return members;
}
