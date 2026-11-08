import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import webpush from "web-push";
import type { PushPayload, PushResult, PushSender, PushSubscription } from "./push.ts";

export type Vapid = { publicKey: string; privateKey: string };

/**
 * The server's VAPID key pair (RFC 8292), made once and kept in `<dataDir>/vapid.json` with mode 600. It never goes in
 * the repository or a log: the private key lets anyone push as this server. Changing it would orphan every subscription.
 */
export async function loadVapid(dataDir: string): Promise<Vapid> {
	const file = join(dataDir, "vapid.json");
	try {
		return JSON.parse(await readFile(file, "utf8")) as Vapid;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const keys = webpush.generateVAPIDKeys();
	try {
		// "wx": if two starts race, the loser reads the winner's file instead of replacing it.
		await writeFile(file, JSON.stringify(keys, null, 2), { mode: 0o600, flag: "wx" });
		await chmod(file, 0o600);
		return keys;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		return JSON.parse(await readFile(file, "utf8")) as Vapid;
	}
}

/**
 * Production sender: Web Push with VAPID and payload encryption (RFC 8291) through the `web-push` package, which is the
 * widely used implementation of both, so Hamkey does not hand-roll cryptography.
 */
export class WebPushSender implements PushSender {
	readonly #vapid: Vapid;
	readonly #subject: string;

	/** `subject` is a mailto: or https: contact the push service may use to reach the Operator. */
	constructor(vapid: Vapid, subject: string) {
		this.#vapid = vapid;
		this.#subject = subject;
	}

	async send(subscription: PushSubscription, payload: PushPayload): Promise<PushResult> {
		try {
			await webpush.sendNotification(subscription, JSON.stringify(payload), {
				vapidDetails: { subject: this.#subject, ...this.#vapid },
				TTL: 60 * 60 * 24,
				urgency: "high",
				timeout: 10_000,
			});
			return "ok";
		} catch (error) {
			const status = (error as { statusCode?: number }).statusCode;
			// Only the status is logged: the error text can contain the endpoint.
			if (status !== 404 && status !== 410) console.warn(`Push was not delivered (status ${status ?? "none"}).`);
			return status === 404 || status === 410 ? "gone" : "failed";
		}
	}
}
