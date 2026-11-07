import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { LearnedNotes } from "../memory/learned-notes.ts";
import type { Memory } from "../memory/memory.ts";
import type { ChatEngine, RequestGate } from "./engine.ts";
import type { AccessResolver } from "./memory-tools.ts";
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
	learned: LearnedNotes;
	memoryAccess: AccessResolver;
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
		learned: options.learned,
		memoryAccess: options.memoryAccess,
		onFailure: options.onFailure,
	});
}
