import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AskLog } from "./ask-log.ts";
import { Bots, loadBots } from "./bots.ts";
import { CardStore } from "./card-store.ts";
import { Exposure } from "./exposure.ts";
import { createApp, listenLocal } from "./app.ts";
import { openOpenRouterEngine } from "./chat/openrouter.ts";
import { loadConfig } from "./config.ts";
import { seedBots } from "./seed.ts";
import { LearnedNotes } from "./memory/learned-notes.ts";
import { FileMemory } from "./memory/file-memory.ts";
import { loadMembers } from "./members.ts";
import { productionWeb } from "./web/brave.ts";
import { DailySpend } from "./spend.ts";
import { Threads } from "./threads.ts";
import { Push } from "./push.ts";
import { loadVapid, WebPushSender } from "./web-push-sender.ts";

const config = loadConfig();
if (!process.env.OPENROUTER_API_KEY) console.warn("OPENROUTER_API_KEY is not set: Bots cannot answer until it is.");

if (!process.env.BRAVE_SEARCH_API_KEY) console.warn("BRAVE_SEARCH_API_KEY is not set: the Research Bot cannot search the web until it is.");

await mkdir(config.dataDir, { recursive: true });
const members = await loadMembers(config.dataDir);
for (const id of await seedBots(config.dataDir)) console.log(`Seeded Bot ${id} added to ${join(config.dataDir, "bots")}.`);

const memory = new FileMemory(config.dataDir);
const cards = new CardStore(config.dataDir);
const exposure = new Exposure(config.dataDir);
const bots = new Bots(await loadBots(config.dataDir, members), members, config.dataDir);

const askLog = new AskLog(config.dataDir, (id) => bots.name(id));

// The limit reads the engine's totals and the engine asks the limit before each request, so one is bound late.
let spend: DailySpend | undefined;
const engine = await openOpenRouterEngine({
	gate: () => spend!.refusal(),
	members,
	web: productionWeb(),
	memory,
	cards,
	learned: new LearnedNotes(config.dataDir),
	exposure,
	botName: (id) => bots.name(id),
	recordAsk: (entry) => askLog.record(entry),
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
const vapid = await loadVapid(config.dataDir);
// The contact the push services may use to reach the Operator (RFC 8292 needs one).
const push = new Push({ dataDir: config.dataDir, sender: new WebPushSender(vapid, process.env.HAMKEY_PUSH_SUBJECT || "mailto:hamkey@example.com"), publicKey: vapid.publicKey });
push.watch(cards);
const server = createApp({
	push,
	members,
	spend,
	memory,
	cards,
	exposure,
	askLog,
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
