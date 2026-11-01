import { createModels } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { Memory } from "../memory/memory.ts";
import type { ChatEngine } from "./engine.ts";
import type { AccessResolver } from "./memory-tools.ts";
import { openPiEngine } from "./pi-engine.ts";

/**
 * The production engine: Bots answer through OpenRouter. The provider reads the key from the server's environment and the
 * only tools installed are the memory tools, which find their scopes from the conversation.
 */
export function openOpenRouterEngine(options: {
	storagePath: string;
	modelId: string;
	memory: Memory;
	memoryAccess: AccessResolver;
	onFailure?: (error: unknown) => void;
}): Promise<ChatEngine> {
	const models = createModels();
	models.setProvider(openrouterProvider());
	return openPiEngine({
		storagePath: options.storagePath,
		models,
		model: { provider: "openrouter", modelId: options.modelId },
		memory: options.memory,
		memoryAccess: options.memoryAccess,
		onFailure: options.onFailure,
	});
}
