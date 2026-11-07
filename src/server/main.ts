import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Bots, loadBots } from "./bots.ts";
import { createApp, listenLocal } from "./app.ts";
import { openOpenRouterEngine } from "./chat/openrouter.ts";
import { loadConfig } from "./config.ts";
import { LearnedNotes } from "./memory/learned-notes.ts";
import { FileMemory } from "./memory/file-memory.ts";
import { loadMembers } from "./members.ts";
import { DailySpend } from "./spend.ts";
import { Threads } from "./threads.ts";

const config = loadConfig();
if (!process.env.OPENROUTER_API_KEY) console.warn("OPENROUTER_API_KEY is not set: Bots cannot answer until it is.");

await mkdir(config.dataDir, { recursive: true });
const members = await loadMembers(config.dataDir);

const bots = new Bots(await loadBots(config.dataDir, members), members, config.dataDir);

// The limit reads the engine's totals and the engine asks the limit before each request, so one is bound late.
let spend: DailySpend | undefined;
const engine = await openOpenRouterEngine({
	gate: () => spend!.refusal(),
	memory: new FileMemory(config.dataDir),
	learned: new LearnedNotes(config.dataDir),
	memoryAccess: (binding) => bots.memoryAccess(binding),
	storagePath: join(config.dataDir, "hamkey.sqlite"),
	modelId: config.model.modelId,
	onFailure: (error) => {
		// The conversation store failed and the runtime closed itself. Exit so a supervisor restarts a healthy process.
		console.error("Conversation store failed; exiting.", error);
		process.exit(1);
	},
});
spend = new DailySpend({ dataDir: config.dataDir, limitUsd: config.dailyLimitUsd, total: () => engine.totalSpend() });
const server = createApp({
	members,
	spend,
	engine,
	bots,
	threads: new Threads(config.dataDir, engine, bots),
	devIdentity: config.devIdentity,
	webDir: config.webDir,
});
const port = await listenLocal(server, config.port);
console.log(`Hamkey listening on http://127.0.0.1:${port}${config.devIdentity ? ` (dev identity: ${config.devIdentity})` : ""}`);
console.log(`Default model ${config.model.modelId}; daily spend limit $${config.dailyLimitUsd}, $${(await spend.today()).toFixed(4)} spent today.`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		server.close();
		void engine.close().finally(() => process.exit(0));
	});
}
