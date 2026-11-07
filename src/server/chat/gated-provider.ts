import type { AssistantMessage, AssistantMessageEventStream, Model, Provider } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { RequestGate } from "./engine.ts";

const NO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** A refused request ends as a provider error the runtime does not retry, so the run fails and says why. */
function refused(model: Model<string>, reason: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: NO_USAGE,
		stopReason: "error",
		errorMessage: reason,
		timestamp: Date.now(),
	} as AssistantMessage;
}

/**
 * A provider that asks the gate before every model request, and sends nothing when it refuses. Pi Durable sends every
 * generation and compaction request through the provider, so no model work gets past it. Hamkey does not rely on the
 * provider's own spending limit stopping cleanly.
 */
export function gatedProvider(provider: Provider, gate: RequestGate): Provider {
	const guard =
		(inner: (model: Model<string>, context: never, options?: never) => AssistantMessageEventStream) =>
		(model: Model<string>, context: never, options?: never): AssistantMessageEventStream => {
			const outer = createAssistantMessageEventStream();
			void (async () => {
				let reason: string | undefined;
				try {
					reason = await gate();
				} catch (error) {
					// A gate that cannot decide refuses: an unknown spend must not become an unlimited one.
					reason = `Hamkey could not check today's spending: ${(error as Error).message}`;
				}
				if (reason !== undefined) {
					const message = refused(model, reason);
					outer.push({ type: "error", reason: "error", error: message });
					outer.end(message);
					return;
				}
				const events = inner(model, context, options);
				for await (const event of events) outer.push(event);
				outer.end(await events.result());
			})().catch((error: unknown) => {
				const message = refused(model, (error as Error).message ?? String(error));
				outer.push({ type: "error", reason: "error", error: message });
				outer.end(message);
			});
			return outer;
		};
	const stream = guard(provider.stream.bind(provider) as never);
	const streamSimple = guard(provider.streamSimple.bind(provider) as never);
	return new Proxy(provider, {
		get(target, property) {
			if (property === "stream") return stream;
			if (property === "streamSimple") return streamSimple;
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
