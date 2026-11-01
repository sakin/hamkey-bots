export type ChatMessage = { id: string; role: "user" | "assistant"; text: string };
export type ThreadView = { messages: ChatMessage[]; draft?: string; busy: boolean; error?: string };
export type Me = { member: { id: string; name: string }; bot: { name: string } };

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

// A retry of a send that failed reuses its request id, so the server can tell it is the same message (and a send that
// did arrive but whose reply was lost is not delivered twice).
let attempt: { text: string; requestId: string } | undefined;

export async function sendMessage(text: string): Promise<boolean> {
	if (attempt?.text !== text) attempt = { text, requestId: crypto.randomUUID() };
	try {
		const res = await fetch("/api/primary/messages", {
			method: "POST",
			headers: { ...headers(), "content-type": "application/json" },
			body: JSON.stringify({ text, requestId: attempt.requestId }),
		});
		if (res.ok) attempt = undefined;
		return res.ok;
	} catch {
		return false;
	}
}

/**
 * Follow the thread live. EventSource cannot set headers, so the stream is read with fetch. Reconnects after a drop;
 * each frame is the full committed view, so a reconnect needs no replay.
 */
export function followThread(onView: (view: ThreadView) => void, onState: (online: boolean) => void): () => void {
	let stopped = false;
	let controller: AbortController | undefined;
	(async () => {
		while (!stopped) {
			controller = new AbortController();
			try {
				const res = await fetch("/api/primary/events", { headers: headers(), signal: controller.signal });
				if (!res.ok || !res.body) throw new Error(String(res.status));
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
						if (frame.startsWith("data: ")) onView(JSON.parse(frame.slice(6)));
					}
				}
			} catch {
				/* fall through to retry */
			}
			onState(false);
			if (!stopped) await new Promise((r) => setTimeout(r, 1500));
		}
	})();
	return () => {
		stopped = true;
		controller?.abort();
	};
}
