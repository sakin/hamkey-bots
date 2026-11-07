import type { AssistantMessage, AssistantMessageEventStream, Provider } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

/**
 * Pi's faux provider reports every response as free. This charges each response, answers and failed or aborted
 * attempts alike, a fixed price in US dollars, so tests can drive spend through Pi's own usage totals.
 */
export function pricedProvider(provider: Provider, pricePerResponse: number): Provider {
	const charge = (message: AssistantMessage): AssistantMessage => ({
		...message,
		usage: { ...message.usage, cost: { ...message.usage.cost, total: pricePerResponse } },
	});
	const priced =
		(inner: (...args: never[]) => AssistantMessageEventStream) =>
		(...args: never[]): AssistantMessageEventStream => {
			const outer = createAssistantMessageEventStream();
			void (async () => {
				const events = inner(...args);
				for await (const event of events) {
					if (event.type === "done") outer.push({ ...event, message: charge(event.message) });
					else if (event.type === "error") outer.push({ ...event, error: charge(event.error) });
					else outer.push(event);
				}
				outer.end(charge(await events.result()));
			})();
			return outer;
		};
	const stream = priced(provider.stream.bind(provider) as never);
	const streamSimple = priced(provider.streamSimple.bind(provider) as never);
	return new Proxy(provider, {
		get(target, property) {
			if (property === "stream") return stream;
			if (property === "streamSimple") return streamSimple;
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
