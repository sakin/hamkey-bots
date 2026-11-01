import { createModels } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { ChatEngine } from "./engine.ts";
import { openPiEngine } from "./pi-engine.ts";

/**
 * The production engine: Bots answer through OpenRouter. The provider reads the key from the server's environment and no
 * tool is installed, so no Bot can reach it.
 */
export function openOpenRouterEngine(options: {
	storagePath: string;
	modelId: string;
	onFailure?: (error: unknown) => void;
}): Promise<ChatEngine> {
	const models = createModels();
	models.setProvider(openrouterProvider());
	return openPiEngine({
		storagePath: options.storagePath,
		models,
		model: { provider: "openrouter", modelId: options.modelId },
		onFailure: options.onFailure,
	});
}
