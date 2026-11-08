import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { LearnedNotes } from "../memory/learned-notes.ts";
import type { CardStore } from "../card-store.ts";
import type { Exposure } from "../exposure.ts";
import type { Memory } from "../memory/memory.ts";
import type { ChatEngine, RequestGate } from "./engine.ts";
import type { AccessResolver } from "./memory-tools.ts";
import type { WebAccess } from "../web/web-access.ts";
import { openPiEngine } from "./pi-engine.ts";

/**
 * The production engine: Bots answer through OpenRouter. The provider reads the key from the server's environment and the
 * only tools installed are the memory tools, which find their scopes from the conversation.
 */
export function openOpenRouterEngine(options: {
	storagePath: string;
	modelId: string;
	members: readonly { id: string; name: string }[];
	memory: Memory;
	cards: CardStore;
	learned: LearnedNotes;
	exposure: Exposure;
	botName: (botId: string) => string | undefined;
	memoryAccess: AccessResolver;
	web: WebAccess;
	gate?: RequestGate;
	onFailure?: (error: unknown) => void;
}): Promise<ChatEngine> {
	return openPiEngine({
		storagePath: options.storagePath,
		provider: openrouterProvider(),
		gate: options.gate,
		model: { provider: "openrouter", modelId: options.modelId },
		members: options.members,
		memory: options.memory,
		cards: options.cards,
		learned: options.learned,
		exposure: options.exposure,
		botName: options.botName,
		memoryAccess: options.memoryAccess,
		web: options.web,
		onFailure: options.onFailure,
	});
}
