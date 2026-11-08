import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CardStore } from "./card-store.ts";

/** A browser's Web Push subscription, as `PushManager.subscribe()` returns it as JSON. */
export type PushSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };

/**
 * What a push carries. It is the same for every push on purpose: it names no Bot and quotes nothing, because push
 * services outside the household carry it (the payload is encrypted, but the service still sees that a push happened).
 */
export type PushPayload = { title: string; body: string; url: string };
export const GENERIC_PUSH: PushPayload = { title: "Hamkey", body: "A Bot needs you", url: "/" };

/** "gone" means the push service says the subscription no longer exists, so it should be dropped. */
export type PushResult = "ok" | "gone" | "failed";
export interface PushSender {
	send(subscription: PushSubscription, payload: PushPayload): Promise<PushResult>;
}

export class InvalidSubscription extends Error {}

/** Most devices one Member may register, so the file and the fan-out stay small. */
export const MAX_SUBSCRIPTIONS = 10;
const MAX_ENDPOINT = 1024;

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const decoded = (value: string) => Buffer.from(value, "base64url").length;

/**
 * Checks a subscription a client sent and returns only the fields Hamkey uses. The server will POST to the endpoint, so
 * it must be an https address with a name, not a bare IP or localhost that would point the server at its own network.
 */
export function validateSubscription(input: unknown): PushSubscription {
	const body = (input ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
	const { endpoint } = body;
	if (typeof endpoint !== "string" || endpoint.length > MAX_ENDPOINT) throw new InvalidSubscription("The endpoint must be a web address of at most 1024 characters.");
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		throw new InvalidSubscription("The endpoint is not a web address.");
	}
	const host = url.hostname;
	if (url.protocol !== "https:" || url.username !== "" || url.password !== "") throw new InvalidSubscription("The endpoint must be an https address.");
	if (!host.includes(".") || host.startsWith("[") || /^[\d.]+$/.test(host) || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
		throw new InvalidSubscription("The endpoint must be a public host name.");
	}
	const { p256dh, auth } = body.keys ?? {};
	// p256dh is an uncompressed P-256 point (65 bytes); auth is a 16-byte secret (RFC 8291).
	if (typeof p256dh !== "string" || !BASE64URL.test(p256dh) || decoded(p256dh) !== 65) throw new InvalidSubscription("keys.p256dh is not a valid key.");
	if (typeof auth !== "string" || !BASE64URL.test(auth) || decoded(auth) !== 16) throw new InvalidSubscription("keys.auth is not a valid secret.");
	return { endpoint, keys: { p256dh, auth } };
}

/**
 * Push subscriptions per Member, kept in `<dataDir>/push.json` (readable by the Operator only: an endpoint is a
 * capability to push to a device), and the rule for when a push is sent: once, when a Card first starts waiting.
 */
export class Push {
	readonly #file: string;
	readonly #sender: PushSender;
	#loading: Promise<Record<string, PushSubscription[]>> | undefined;
	#writes: Promise<unknown> = Promise.resolve();
	readonly #pending = new Set<Promise<unknown>>();
	/** The VAPID public key the browser subscribes with. */
	readonly publicKey: string;

	constructor(options: { dataDir: string; sender: PushSender; publicKey: string }) {
		this.#file = join(options.dataDir, "push.json");
		this.#sender = options.sender;
		this.publicKey = options.publicKey;
	}

	#load() {
		this.#loading ??= readFile(this.#file, "utf8").then(
			(raw) => JSON.parse(raw) as Record<string, PushSubscription[]>,
			(error) => {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
				throw error;
			},
		);
		this.#loading.catch(() => (this.#loading = undefined));
		return this.#loading;
	}

	#change<T>(change: (all: Record<string, PushSubscription[]>) => T): Promise<T> {
		const run = this.#writes.then(async () => {
			const next = structuredClone(await this.#load());
			const result = change(next);
			await mkdir(join(this.#file, ".."), { recursive: true });
			await writeFile(`${this.#file}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
			await rename(`${this.#file}.tmp`, this.#file);
			this.#loading = Promise.resolve(next);
			return result;
		});
		this.#writes = run.catch(() => {});
		return run;
	}

	/**
	 * Registers a device for a Member. A device (endpoint) belongs to one Member at a time: registering it again moves it,
	 * so a phone handed to the other Member never keeps pushing to the first.
	 */
	async subscribe(memberId: string, subscription: PushSubscription): Promise<void> {
		await this.#change((all) => {
			for (const [id, list] of Object.entries(all)) all[id] = list.filter((s) => s.endpoint !== subscription.endpoint);
			const mine = (all[memberId] ??= []);
			mine.push(subscription);
			// The oldest registrations go first once the limit is reached.
			while (mine.length > MAX_SUBSCRIPTIONS) mine.shift();
		});
	}

	/** Removes this Member's device. Another Member's registration of the same endpoint is not touched. */
	async unsubscribe(memberId: string, endpoint: string): Promise<void> {
		await this.#change((all) => {
			all[memberId] = (all[memberId] ?? []).filter((s) => s.endpoint !== endpoint);
		});
	}

	async subscriptionsFor(memberId: string): Promise<PushSubscription[]> {
		await this.#writes;
		return (await this.#load())[memberId] ?? [];
	}

	/**
	 * Sends one push to every device of each addressee. Only the Card store's "made" events reach here, so tools never know
	 * push exists and a settled Card sends nothing.
	 */
	watch(cards: CardStore): () => void {
		return cards.subscribe((card) => {
			// A newly made Card is waiting; settling one announces it with another status.
			if (card.status !== "waiting") return;
			for (const memberId of card.addressees) this.#track(this.#notify(memberId));
		});
	}

	async #notify(memberId: string) {
		for (const subscription of await this.subscriptionsFor(memberId)) {
			const result = await this.#sender.send(subscription, GENERIC_PUSH).catch((): PushResult => "failed");
			if (result === "gone") await this.unsubscribe(memberId, subscription.endpoint);
		}
	}

	#track(work: Promise<unknown>) {
		const tracked = work.catch(() => {}).finally(() => this.#pending.delete(tracked));
		this.#pending.add(tracked);
	}

	/** Resolves when every push started so far has been handed to the sender. For tests. */
	async idle(): Promise<void> {
		while (this.#pending.size > 0) await Promise.all(this.#pending);
	}
}
