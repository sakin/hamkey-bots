import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FileMemory } from "../src/server/memory/file-memory.ts";
import { memoryContract } from "./memory-contract.ts";

memoryContract("FileMemory", async () => new FileMemory(await mkdtemp(join(tmpdir(), "hamkey-memory-"))));

it("FileMemory keeps facts across a restart", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hamkey-memory-"));
	await new FileMemory(dir).saveFact({ kind: "household" }, "We have a dog called Biscuit");
	const facts = await new FileMemory(dir).loadSummary([{ kind: "household" }]);
	expect(facts.map((f) => f.text)).toEqual(["We have a dog called Biscuit"]);
});
