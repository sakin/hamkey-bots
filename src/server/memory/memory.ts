/**
 * Hamkey's memory interface. Facts live outside any thread, so they survive compaction and a thread being replaced.
 * An implementation is swappable: `test/memory-contract.ts` is what any implementation must pass.
 *
 * Callers never pass a bare scope from the model. The tools in `chat/memory-tools.ts` get their scopes from the Bot and
 * Member bound to the conversation (ADR 0002); this module only enforces that a read or forget stays inside the scopes
 * it is given.
 */

/** Household memory, one Member's personal memory, or one Bot's own memory (per Member when the Bot is Common). */
export type Scope =
	| { kind: "household" }
	| { kind: "member"; member: string }
	| { kind: "bot"; bot: string; member?: string };

export type Fact = { id: string; scope: Scope; text: string; savedAt: string };

export interface Memory {
	/** Every fact in the scopes, newest first, for putting in front of a Bot. At most `limit` facts when given. */
	loadSummary(scopes: readonly Scope[], limit?: number): Promise<Fact[]>;
	/** Stores one fact in one scope. */
	saveFact(scope: Scope, text: string): Promise<Fact>;
	/** Facts in the scopes that contain any word of the query, best fit first and newest first among equals. */
	search(scopes: readonly Scope[], query: string): Promise<Fact[]>;
	/** Removes one fact, only if it is in one of the scopes. Returns whether anything was removed. */
	forget(scopes: readonly Scope[], factId: string): Promise<boolean>;
}

export function scopeKey(scope: Scope): string {
	switch (scope.kind) {
		case "household":
			return "household";
		case "member":
			return `member:${scope.member}`;
		case "bot":
			return scope.member === undefined ? `bot:${scope.bot}` : `bot:${scope.bot}:${scope.member}`;
	}
}

export function sameScope(a: Scope, b: Scope): boolean {
	return scopeKey(a) === scopeKey(b);
}

/** Lowercase words of a query. */
const words = (query: string) => query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w !== "");

/**
 * How well a fact's text fits a query: the number of query words it contains (a plural also matches its singular).
 * An empty query fits everything equally. Zero means no match. Models phrase queries loosely, so one matching word
 * is enough to find a fact, and more matching words rank it higher.
 */
export function score(text: string, query: string): number {
	const wanted = words(query);
	if (wanted.length === 0) return 1;
	const haystack = text.toLowerCase();
	return wanted.filter((w) => haystack.includes(w) || (w.length > 3 && w.endsWith("s") && haystack.includes(w.slice(0, -1)))).length;
}
