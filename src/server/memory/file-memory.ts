import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { type Fact, type Memory, matches, type Scope, scopeKey } from "./memory.ts";

/** Memory kept as one JSON file per scope under `<dataDir>/memory`, so the Operator can read or hand-edit it. */
export class FileMemory implements Memory {
	readonly #dir: string;
	/** Writes run one at a time, so two saves to one scope cannot lose each other. */
	#writes: Promise<unknown> = Promise.resolve();

	constructor(dataDir: string) {
		this.#dir = join(dataDir, "memory");
	}

	async loadSummary(scopes: readonly Scope[], limit?: number): Promise<Fact[]> {
		const facts = await this.#all(scopes);
		return limit === undefined ? facts : facts.slice(0, limit);
	}

	async saveFact(scope: Scope, text: string): Promise<Fact> {
		const clean = text.trim();
		if (clean === "") throw new Error("A fact cannot be empty.");
		const fact: Fact = { id: randomUUID(), scope, text: clean, savedAt: new Date().toISOString() };
		await this.#update(scope, (facts) => [...facts, fact]);
		return fact;
	}

	async search(scopes: readonly Scope[], query: string): Promise<Fact[]> {
		return (await this.#all(scopes)).filter((f) => matches(f.text, query));
	}

	async forget(scopes: readonly Scope[], factId: string): Promise<boolean> {
		let removed = false;
		for (const scope of scopes) {
			await this.#update(scope, (facts) => {
				const kept = facts.filter((f) => f.id !== factId);
				if (kept.length !== facts.length) removed = true;
				return kept;
			});
		}
		return removed;
	}

	async #all(scopes: readonly Scope[]): Promise<Fact[]> {
		await this.#writes;
		const lists = await Promise.all(scopes.map((s) => this.#read(s)));
		return lists.flat().sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
	}

	#path(scope: Scope): string {
		return join(this.#dir, `${encodeURIComponent(scopeKey(scope))}.json`);
	}

	async #read(scope: Scope): Promise<Fact[]> {
		try {
			return JSON.parse(await readFile(this.#path(scope), "utf8")) as Fact[];
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}

	#update(scope: Scope, change: (facts: Fact[]) => Fact[]): Promise<void> {
		const write = this.#writes.then(async () => {
			const before = await this.#read(scope);
			const after = change(before);
			if (after.length === before.length && after.every((f, i) => f === before[i])) return;
			await mkdir(this.#dir, { recursive: true });
			const path = this.#path(scope);
			await writeFile(`${path}.tmp`, JSON.stringify(after, null, 2));
			await rename(`${path}.tmp`, path);
		});
		this.#writes = write.catch(() => {});
		return write;
	}
}
