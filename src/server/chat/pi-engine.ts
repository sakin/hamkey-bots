import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, type Provider } from "@earendil-works/pi-ai";
import { type CompactionSettings, createRegistry, Harness } from "@earendil-works/pi-durable";
import type { LearnedNotes } from "../memory/learned-notes.ts";
import type { Memory } from "../memory/memory.ts";
import { type AccessResolver, BindingDoc, memoryExtension } from "./memory-tools.ts";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Author, ChatEngine, ChatMessage, RequestGate, ThreadId, ThreadSpec, ThreadView } from "./engine.ts";
import { gatedProvider } from "./gated-provider.ts";
import { sharedThreadExtension } from "./shared-thread.ts";

/** The entry kind of a message sent through Hamkey. It records who wrote it; the model sees the input's `content`. */
const MESSAGE_KIND = "hamkey.message";

export type { CompactionSettings };
export type PiEngineOptions = {
	/** SQLite file holding every conversation (ADR 0005). */
	storagePath: string;
	/** Where model requests go. Every request passes `gate` first. */
	provider: Provider;
	model: { provider: string; modelId: string };
	/** Asked before every model request, such as the daily spend limit. Absent lets every request through. */
	gate?: RequestGate;
	/** Overrides for when long threads compact; tests shrink the thresholds. */
	compaction?: CompactionSettings;
	/** Both Members, so a Bot in a shared thread knows who is in it. */
	members: readonly { id: string; name: string }[];
	memory: Memory;
	learned: LearnedNotes;
	/** What a Bot may do with memory, as the Bot is defined now. */
	memoryAccess: AccessResolver;
	/** Called once if the store fails and the runtime shuts itself down; the process should exit so it is restarted. */
	onFailure?: (error: unknown) => void;
};

type Block = { type: string; text?: string };
type Entry = { id: string; kind: string; data?: unknown; model?: readonly { role: string; content: unknown }[] };

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
		if (entry.kind === MESSAGE_KIND) {
			const data = entry.data as { author?: string; text?: string } | undefined;
			messages.push({ id: entry.id, role: "user", text: data?.text ?? textOf(message?.content), author: data?.author });
		} else if (entry.kind === "pi.user" && message?.role === "user") {
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
	const memoryTools = memoryExtension(options.memory, options.learned, options.memoryAccess);
	const registry = createRegistry();
	registry.install(memoryTools);
	registry.install(sharedThreadExtension(options.members));
	// Refusals the gate gave, so a run that failed on one shows the Member its words rather than a generic error.
	const refusals = new Set<string>();
	const gate: RequestGate = async () => {
		const reason = await options.gate?.();
		if (reason !== undefined) refusals.add(reason);
		return reason;
	};
	const models = createModels();
	models.setProvider(gatedProvider(options.provider, gate));
	const harness = await Harness.open(
		await openNodeSqliteStorage(options.storagePath),
		{
			models,
			registry,
			settings: { followUpMode: "all", afterFailedRun: "continue", compaction: { enabled: true, ...options.compaction } },
		},
		context,
	);
	harness.resume();
	void harness.closed.then((end) => {
		if (end.reason === "failed") options.onFailure?.(end.error);
	});

	const errors = new Map<ThreadId, string>();
	const listeners = new Map<ThreadId, Set<() => void>>();
	const poke = (thread: ThreadId) => listeners.get(thread)?.forEach((l) => l());

	/** What a thread runs with: the Bot's model and instructions, and only the tools the Bot has. */
	function agentFor(spec: ThreadSpec) {
		const offered = options.memoryAccess({ botId: spec.botId, memberId: spec.memberId ?? null })?.tools ?? [];
		return {
			model: { provider: options.model.provider, modelId: spec.model ?? options.model.modelId },
			instructions: spec.instructions,
			tools: (memoryTools.tools ?? []).filter((t) => offered.includes(t.name)),
		};
	}

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
			const binding = { botId: spec.botId, memberId: spec.memberId ?? null };
			const created = await harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					agent: agentFor(spec),
					init: async (tx, id) => {
						Object.assign(await tx.doc(BindingDoc, id), binding);
					},
				},
				context,
			);
			return created.id as unknown as string;
		},

		async configure(thread, spec) {
			const target = await conversation(thread);
			const wanted = agentFor(spec);
			const current = await target.agent(context);
			const same =
				current.instructions === wanted.instructions &&
				current.model?.modelId === wanted.model.modelId &&
				current.tools.map((t) => t.name).join() === wanted.tools.map((t) => t.name).join();
			if (!same) await target.configure(wanted, context);
		},

		listModels() {
			return models.getModels(options.model.provider).map((m) => ({ id: m.id, name: m.name }));
		},

		defaultModel: options.model.modelId,

		async send(thread, text, requestId, author: Author, labelled) {
			const target = await conversation(thread);
			errors.delete(thread);
			const submission = await target.submit(
				{
					type: "input",
					content: labelled ? `${author.name}: ${text}` : text,
					entry: { kind: MESSAGE_KIND, data: { author: author.id, text } },
					requestId,
				},
				context,
			);
			void submission.wait(context).then(
				(settled) => {
					// With `afterFailedRun: "continue"` a message queued behind a failed run is still answered. An answer
					// means the thread is not stuck, so an earlier message's error must not keep showing.
					if (settled.status === "done") errors.delete(thread);
					if (settled.status === "unanswered") {
						const detail = typeof settled.detail === "string" ? settled.detail : undefined;
						errors.set(thread, detail !== undefined && refusals.has(detail) ? detail : "The Bot could not answer. Try again.");
					}
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

		async totalSpend() {
			const usage = await harness.usage(context);
			const all = [...Object.values(usage.models), ...Object.values(usage.tools)];
			return all.reduce((sum, u) => sum + (u.cost?.total ?? 0), 0);
		},

		async close() {
			await harness.close(context);
		},
	};
}
