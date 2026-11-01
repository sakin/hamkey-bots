import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { createApp, listenLocal } from "./app.ts";
import { openPiEngine } from "./chat/pi-engine.ts";
import { loadConfig } from "./config.ts";
import { loadMembers } from "./members.ts";
import { Threads } from "./threads.ts";

const config = loadConfig();
if (!process.env.OPENROUTER_API_KEY) console.warn("OPENROUTER_API_KEY is not set: Bots cannot answer until it is.");

await mkdir(config.dataDir, { recursive: true });
const members = await loadMembers(config.dataDir);

// The key is read from the server's environment by the provider. No tool is installed, so no Bot can reach it.
const models = createModels();
models.setProvider(openrouterProvider());

const engine = await openPiEngine({ storagePath: join(config.dataDir, "hamkey.sqlite"), models, model: config.model });
const server = createApp({
	members,
	engine,
	threads: new Threads(config.dataDir, engine),
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
