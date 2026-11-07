export type ChatMessage = { id: string; role: "user" | "assistant"; text: string };
export type ThreadView = { messages: ChatMessage[]; draft?: string; busy: boolean; error?: string };
export type Me = { member: { id: string; name: string }; devMembers?: string[] };
export type BotKind = "personal" | "household" | "common";
export type BotSummary = { id: string; name: string; kind: BotKind; editable: boolean; warning?: string };
export type BotDefinition = BotSummary & { instructions: string; model: string | null; tools: string[] };
export type BotForm = { name: string; instructions: string; model: string | null; tools: string[]; kind: BotKind };
export type Catalog = { models: { id: string; name: string }[]; defaultModel: string; tools: string[] };

/** Development only: pick which Member to act as when the server runs with a development identity. */
const DEV_KEY = "hamkey.devMember";
export function devMember(): string | undefined {
	if (!import.meta.env.DEV) return undefined;
	try {
		return localStorage.getItem(DEV_KEY) ?? undefined;
	} catch {
		return undefined;
	}
}
export function setDevMember(id: string) {
	try {
		localStorage.setItem(DEV_KEY, id);
	} catch {}
}

function headers(): Record<string, string> {
	const dev = devMember();
	return dev ? { "x-hamkey-dev-member": dev } : {};
}

export async function fetchMe(): Promise<Me | undefined> {
	const res = await fetch("/api/me", { headers: headers() });
	return res.ok ? res.json() : undefined;
}

export async function fetchBots(): Promise<BotSummary[] | undefined> {
	try {
		const res = await fetch("/api/bots", { headers: headers() });
		return res.ok ? (await res.json()).bots : undefined;
	} catch {
		return undefined;
	}
}

// A retry of a send that failed reuses its request id, so the server can tell it is the same message (and a send that
// did arrive but whose reply was lost is not delivered twice).
const attempts = new Map<string, { text: string; requestId: string }>();

/** Sends a message. Undefined means it was accepted; otherwise the reason it was not, to show the Member. */
export async function sendMessage(botId: string, text: string): Promise<string | undefined> {
	let attempt = attempts.get(botId);
	if (attempt?.text !== text) attempts.set(botId, (attempt = { text, requestId: crypto.randomUUID() }));
	try {
		const res = await fetch(`/api/bots/${encodeURIComponent(botId)}/messages`, {
			method: "POST",
			headers: { ...headers(), "content-type": "application/json" },
			body: JSON.stringify({ text, requestId: attempt.requestId }),
		});
		if (res.ok) {
			attempts.delete(botId);
			return undefined;
		}
		const body = await res.json().catch(() => ({}));
		return typeof body.error === "string" ? body.error : "Could not send. Try again.";
	} catch {
		return "Could not reach the server. Try again.";
	}
}

/**
 * Follow the thread live. EventSource cannot set headers, so the stream is read with fetch. Reconnects after a drop;
 * each frame is the full committed view, so a reconnect needs no replay.
 */
export function followThread(botId: string, onView: (view: ThreadView) => void, onState: (online: boolean) => void): () => void {
	let stopped = false;
	let controller: AbortController | undefined;
	(async () => {
		while (!stopped) {
			controller = new AbortController();
			try {
				const res = await fetch(`/api/bots/${encodeURIComponent(botId)}/events`, { headers: headers(), signal: controller.signal });
				if (!res.ok || !res.body) throw new Error(String(res.status));
				if (stopped) return;
				onState(true);
				const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
				let buffer = "";
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					buffer += value;
					let end: number;
					while ((end = buffer.indexOf("\n\n")) !== -1) {
						const frame = buffer.slice(0, end);
						buffer = buffer.slice(end + 2);
						if (!stopped && frame.startsWith("data: ")) onView(JSON.parse(frame.slice(6)));
					}
				}
			} catch {
				/* fall through to retry */
			}
			if (stopped) return;
			onState(false);
			await new Promise((r) => setTimeout(r, 1500));
		}
	})();
	return () => {
		stopped = true;
		controller?.abort();
	};
}

export async function fetchCatalog(): Promise<Catalog | undefined> {
	try {
		const res = await fetch("/api/models", { headers: headers() });
		return res.ok ? res.json() : undefined;
	} catch {
		return undefined;
	}
}

export async function fetchDefinition(botId: string): Promise<BotDefinition | undefined> {
	try {
		const res = await fetch(`/api/bots/${encodeURIComponent(botId)}/definition`, { headers: headers() });
		return res.ok ? res.json() : undefined;
	} catch {
		return undefined;
	}
}

/** Creates (no `botId`) or edits a Bot. Returns the saved Bot, or the reason it was refused. */
export async function saveBot(form: BotForm, botId?: string): Promise<{ bot: BotDefinition } | { error: string }> {
	try {
		const res = await fetch(botId === undefined ? "/api/bots" : `/api/bots/${encodeURIComponent(botId)}`, {
			method: botId === undefined ? "POST" : "PUT",
			headers: { ...headers(), "content-type": "application/json" },
			body: JSON.stringify(form),
		});
		const body = await res.json().catch(() => ({}));
		return res.ok ? { bot: body } : { error: body.error ?? "Could not save the Bot." };
	} catch {
		return { error: "Could not reach the server." };
	}
}
