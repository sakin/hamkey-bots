import type { PushPayload, PushResult, PushSender, PushSubscription } from "../src/server/push.ts";

/** A push service that records every push instead of sending it. Set `answer` to rehearse a service rejecting a subscription. */
export class FakePush implements PushSender {
	readonly sent: { subscription: PushSubscription; payload: PushPayload }[] = [];
	answer: (subscription: PushSubscription) => PushResult = () => "ok";

	async send(subscription: PushSubscription, payload: PushPayload): Promise<PushResult> {
		this.sent.push({ subscription, payload });
		return this.answer(subscription);
	}

	/** The endpoints pushed to so far. */
	get endpoints(): string[] {
		return this.sent.map((s) => s.subscription.endpoint);
	}
}
