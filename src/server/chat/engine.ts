/**
 * Hamkey's thin interface to the conversation runtime (ADR 0001). Nothing outside the `chat/` folder imports Pi Durable,
 * so an upgrade or replacement touches one file.
 */

export type ThreadId = string;

/** `author` is the id of the Member who wrote a user message. Threads from before authors were recorded have none. */
export type ChatMessage = { id: string; role: "user" | "assistant"; text: string; author?: string };

/** The Member behind a message. */
export type Author = { id: string; name: string };

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

/**
 * Asked before every model request. A string refuses the request; it is shown to the Member as is, so it must be
 * plain words. Undefined lets the request go ahead.
 */
export type RequestGate = () => Promise<string | undefined>;

export interface ChatEngine {
	createThread(spec: ThreadSpec): Promise<ThreadId>;
	/** Brings an existing thread up to date with its Bot's definition. Takes effect from the thread's next model request. */
	configure(thread: ThreadId, spec: ThreadSpec): Promise<void>;
	/** The models a Bot may be set to, from the provider's catalog. */
	listModels(): ModelInfo[];
	/** The model a Bot uses when it names none. */
	readonly defaultModel: string;
	/**
	 * Adds a message from `author`. With `labelled`, the model sees it prefixed with the author's name, which a thread
	 * shared by both Members needs; the thread's view always shows the plain text.
	 */
	send(thread: ThreadId, text: string, requestId: string, author: Author, labelled: boolean): Promise<void>;
	view(thread: ThreadId): Promise<ThreadView>;
	/** Calls `listener` with the current view, then after every commit. Returns an unsubscribe function. */
	subscribe(thread: ThreadId, listener: (view: ThreadView) => void): Promise<() => void>;
	/** US dollars spent on models and tools across every thread since the store began, failed and aborted attempts included. */
	totalSpend(): Promise<number>;
	close(): Promise<void>;
}
