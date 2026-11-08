/** `sender` is the Member who wrote a user message, or the Bot for a reply. Old messages may have none. */
export type ChatMessage = { id: string; role: "user" | "assistant"; text: string; /** ms since the epoch; Cards are placed among messages by time. */ at?: number; sender?: { id: string; name: string }; /** Set on replies built from web pages. */ untrusted?: boolean };
/** A Card as the server sends it. Every field is plain text and is drawn as text, never as HTML. */
export type Card = {
	id: string;
	/** ISO time the Bot posted it. */
	createdAt?: string;
	type: "approval" | "choice" | "question";
	status: "waiting" | "approved" | "rejected" | "chosen" | "answered";
	bot: { id: string; name: string };
	/** Approval: fact, topic, topicLabel. Choice: question, options. Question: question. */
	fields: { fact?: string; topicLabel?: string; question?: string; options?: string[] };
	/** Index of the option picked on a Choice Card. */
	choice?: number;
	/** Name of the Member who tapped. */
	resolvedBy?: string;
};
export type ThreadView = { messages: ChatMessage[]; draft?: string; busy: boolean; error?: string; cards?: Card[] };
export type Me = { member: { id: string; name: string }; devMembers?: string[] };
export type BotKind = "personal" | "household" | "common";
export type BotSummary = { id: string; name: string; kind: BotKind; shared: boolean; editable: boolean; /** The Bot reads the web, so its answers need checking. */ web?: boolean; warning?: string };
export type BotDefinition = BotSummary & { instructions: string; model: string | null; tools: string[] };
export type BotForm = { name: string; instructions: string; model: string | null; tools: string[]; kind: BotKind };
export type Catalog = { models: { id: string; name: string }[]; defaultModel: string; tools: string[]; /** Ticked for a new Bot. */ defaultTools: string[] };

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

/** Taps a Card. Undefined means the server took it; otherwise the reason it did not, to show the Member. */
export async function actOnCard(cardId: string, action: { action: "approve" | "reject" } | { action: "choose"; option: number }): Promise<string | undefined> {
	try {
		const res = await fetch(`/api/cards/${encodeURIComponent(cardId)}/actions`, {
			method: "POST",
			headers: { ...headers(), "content-type": "application/json" },
			body: JSON.stringify(action),
		});
		if (res.ok) return undefined;
		const body = await res.json().catch(() => ({}));
		return typeof body.error === "string" ? body.error : "Could not do that. Try again.";
	} catch {
		return "Could not reach the server. Try again.";
	}
}

export type ExposureView = {
	/** Topic id to the ids of the Bots allowed to Ask about it. */
	exposure: Record<string, string[]>;
	topics: { id: string; label: string }[];
	bots: { id: string; name: string; kind: BotKind }[];
};

export async function fetchExposure(): Promise<ExposureView | undefined> {
	try {
		const res = await fetch("/api/exposure", { headers: headers() });
		return res.ok ? res.json() : undefined;
	} catch {
		return undefined;
	}
}

/** Saves the Member's own Exposure List. Returns the saved list, or the reason it was refused. */
export async function saveExposure(exposure: Record<string, string[]>): Promise<{ view: ExposureView } | { error: string }> {
	try {
		const res = await fetch("/api/exposure", {
			method: "PUT",
			headers: { ...headers(), "content-type": "application/json" },
			body: JSON.stringify({ exposure }),
		});
		const body = await res.json().catch(() => ({}));
		return res.ok ? { view: body } : { error: body.error ?? "Could not save." };
	} catch {
		return { error: "Could not reach the server." };
	}
}

/** One line of the Ask log, as the server sends it. All of it is plain text. */
export type AskEntry = {
	id: string;
	time: string;
	/** The asking Bot. */
	bot: string;
	/** The Member the Ask was about. */
	about: string | null;
	topicLabel: string;
	question: string;
	outcome: "refused" | "no-facts" | "answered" | "failed";
	answer?: string;
	reason?: string;
};

export async function fetchAsks(): Promise<AskEntry[] | undefined> {
	try {
		const res = await fetch("/api/asks", { headers: headers() });
		return res.ok ? (await res.json()).asks : undefined;
	} catch {
		return undefined;
	}
}
