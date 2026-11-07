/**
 * Hamkey's thin interface to the conversation runtime (ADR 0001). Nothing outside the `chat/` folder imports Pi Durable,
 * so an upgrade or replacement touches one file.
 */

export type ThreadId = string;

export type ChatMessage = { id: string; role: "user" | "assistant"; text: string };

/** Everything a client needs to draw a thread, taken from committed state only. */
export type ThreadView = {
	messages: ChatMessage[];
	/** Text of the reply being written, as last committed. */
	draft?: string;
	busy: boolean;
	/** Set when the last run failed without an answer. */
	error?: string;
};

/** What a new thread needs. `memberId` is set unless the thread is a Household Bot's shared one. */
export type ThreadSpec = { instructions: string; botId: string; memberId?: string; /** Model id; absent means the engine's default. */ model?: string };

export type ModelInfo = { id: string; name: string };

export interface ChatEngine {
	createThread(spec: ThreadSpec): Promise<ThreadId>;
	/** Brings an existing thread up to date with its Bot's definition. Takes effect from the thread's next model request. */
	configure(thread: ThreadId, spec: ThreadSpec): Promise<void>;
	/** The models a Bot may be set to, from the provider's catalog. */
	listModels(): ModelInfo[];
	/** The model a Bot uses when it names none. */
	readonly defaultModel: string;
	send(thread: ThreadId, text: string, requestId: string): Promise<void>;
	view(thread: ThreadId): Promise<ThreadView>;
	/** Calls `listener` with the current view, then after every commit. Returns an unsubscribe function. */
	subscribe(thread: ThreadId, listener: (view: ThreadView) => void): Promise<() => void>;
	close(): Promise<void>;
}
