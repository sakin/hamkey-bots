import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatEngine } from "../src/server/chat/engine.ts";
import { Bots } from "../src/server/bots.ts";
import { Threads } from "../src/server/threads.ts";
import type { Member } from "../src/server/members.ts";
import { ann, ben } from "./harness.ts";

/** Only thread creation matters here, so the rest of the engine is never called. */
function engineWith(createThread: ChatEngine["createThread"]): ChatEngine {
	return { createThread } as ChatEngine;
}

const bots = new Bots([], [ann, ben]);
const primary = async (threads: Threads, member: Member) => (await threads.mainThread(member, `primary-${member.id}`))?.thread;

describe("thread index", () => {
	it("recovers after a thread could not be created", async () => {
		const dir = await mkdtemp(join(tmpdir(), "hamkey-threads-"));
		let calls = 0;
		const threads = new Threads(
			dir,
			engineWith(async () => {
				if (++calls === 1) throw new Error("store unavailable");
				return "thread-1";
			}),
			bots,
		);
		await expect(primary(threads, ann)).rejects.toThrow("store unavailable");
		expect(await primary(threads, ann)).toBe("thread-1");
	});

	it("keeps both Members' threads when they first use the app at the same moment", async () => {
		const dir = await mkdtemp(join(tmpdir(), "hamkey-threads-"));
		const threads = new Threads(
			dir,
			engineWith(async (spec) => `thread-for-${spec.instructions.includes("Ann") ? "ann" : "ben"}`),
			bots,
		);
		const [a, b] = await Promise.all([primary(threads, ann), primary(threads, ben)]);
		expect(a).not.toBe(b);
		const saved = JSON.parse(await readFile(join(dir, "threads.json"), "utf8"));
		expect(Object.values(saved).sort()).toEqual([a, b].sort());
		// A restart finds the same threads rather than making new ones.
		const restarted = new Threads(dir, engineWith(async () => "should-not-be-called"), bots);
		expect(await primary(restarted, ann)).toBe(a);
		expect(await primary(restarted, ben)).toBe(b);
	});
});
