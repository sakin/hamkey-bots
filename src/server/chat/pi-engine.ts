import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { ChatEngine, ChatMessage, ThreadId, ThreadSpec, ThreadView } from "./engine.ts";

export type PiEngineOptions = {
	/** SQLite file holding every conversation (ADR 0005). */
	storagePath: string;
	models: Models;
	model: { provider: string; modelId: string };
};

type Block = { type: string; text?: string };
type Entry = { id: string; kind: string; model?: readonly { role: string; content: unknown }[] };

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as Block[])
		.filter((b) => b.type === "text")
		.map((b) => b.text ?? "")
		.join("");
}

/** Project committed Pi Durable state into the view the app draws. Only `viewState` is read, never the agent events. */
function project(value: { entries: readonly Entry[]; docs: Readonly<Record<string, unknown>> }): ThreadView {
	const messages: ChatMessage[] = [];
	for (const entry of value.entries) {
		const message = entry.model?.[0];
		if (entry.kind === "pi.user" && message?.role === "user") {
			messages.push({ id: entry.id, role: "user", text: textOf(message.content) });
		} else if (entry.kind === "pi.assistant" && message?.role === "assistant") {
			const text = textOf(message.content);
			if (text !== "") messages.push({ id: entry.id, role: "assistant", text });
		}
	}
	const live = value.docs["pi.live"] as
		| { run?: unknown; generation?: { message?: { content?: unknown } } }
		| undefined;
	const draft = textOf(live?.generation?.message?.content);
	return { messages, draft: draft === "" ? undefined : draft, busy: live?.run !== undefined };
}

export async function openPiEngine(options: PiEngineOptions): Promise<ChatEngine> {
	const harness = await Harness.open(
		await openNodeSqliteStorage(options.storagePath),
		{
			models: options.models,
			registry: createRegistry(),
			settings: { followUpMode: "all", afterFailedRun: "continue" },
		},
		context,
	);
	harness.resume();

	const errors = new Map<ThreadId, string>();
	const listeners = new Map<ThreadId, Set<() => void>>();
	const poke = (thread: ThreadId) => listeners.get(thread)?.forEach((l) => l());

	async function conversation(thread: ThreadId) {
		const found = await harness.conversation(thread as never, context);
		if (found === undefined) throw new Error("Unknown thread");
		return found;
	}

	async function view(thread: ThreadId): Promise<ThreadView> {
		const state = await (await conversation(thread)).viewState(context);
		try {
			const result = project(state.value as never);
			const error = errors.get(thread);
			return error === undefined || result.busy ? result : { ...result, error };
		} finally {
			state.dispose();
		}
	}

	return {
		async createThread(spec: ThreadSpec) {
			const created = await harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					agent: { model: options.model, instructions: spec.instructions },
				},
				context,
			);
			return created.id as unknown as string;
		},

		async send(thread, text, requestId) {
			const target = await conversation(thread);
			errors.delete(thread);
			const submission = await target.submit({ type: "input", content: text, requestId }, context);
			void submission.wait(context).then(
				(settled) => {
					if (settled.status === "unanswered") errors.set(thread, "The Bot could not answer. Try again.");
					poke(thread);
				},
				() => {},
			);
		},

		view,

		async subscribe(thread, listener) {
			const state = await (await conversation(thread)).viewState(context);
			const emit = () => {
				const result = project(state.value as never);
				const error = errors.get(thread);
				listener(error === undefined || result.busy ? result : { ...result, error });
			};
			const unsubscribe = state.subscribe(emit);
			let set = listeners.get(thread);
			if (set === undefined) listeners.set(thread, (set = new Set()));
			set.add(emit);
			emit();
			return () => {
				unsubscribe();
				set.delete(emit);
				state.dispose();
			};
		},

		async close() {
			await harness.close(context);
		},
	};
}
