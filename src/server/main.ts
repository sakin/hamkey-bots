import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Bots, loadBots } from "./bots.ts";
import { createApp, listenLocal } from "./app.ts";
import { openOpenRouterEngine } from "./chat/openrouter.ts";
import { loadConfig } from "./config.ts";
import { loadMembers } from "./members.ts";
import { Threads } from "./threads.ts";

const config = loadConfig();
if (!process.env.OPENROUTER_API_KEY) console.warn("OPENROUTER_API_KEY is not set: Bots cannot answer until it is.");

await mkdir(config.dataDir, { recursive: true });
const members = await loadMembers(config.dataDir);

const bots = new Bots(await loadBots(config.dataDir, members), members);

const engine = await openOpenRouterEngine({
	storagePath: join(config.dataDir, "hamkey.sqlite"),
	modelId: config.model.modelId,
	onFailure: (error) => {
		// The conversation store failed and the runtime closed itself. Exit so a supervisor restarts a healthy process.
		console.error("Conversation store failed; exiting.", error);
		process.exit(1);
	},
});
const server = createApp({
	members,
	engine,
	threads: new Threads(config.dataDir, engine, bots),
	devIdentity: config.devIdentity,
	webDir: config.webDir,
});
const port = await listenLocal(server, config.port);
console.log(`Hamkey listening on http://127.0.0.1:${port}${config.devIdentity ? ` (dev identity: ${config.devIdentity})` : ""}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		server.close();
		void engine.close().finally(() => process.exit(0));
	});
}
