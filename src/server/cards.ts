import { isTopic, TOPICS } from "./memory/topics.ts";

/**
 * The Card catalog: the only kinds of Card that exist, with the exact fields each may carry. A Bot asks for a Card
 * through a tool, but what is stored and shown is whatever passes `validateFields`, so a Bot cannot send markup,
 * scripts, extra fields or a type that is not listed. Everything is plain text; the app draws it as text, never as HTML.
 */

export type CardType = "approval" | "choice";
export const CARD_TYPES: readonly CardType[] = ["approval", "choice"];

/**
 * Approval: asks the Member to share one of their own Facts under a Topic. `fact` is copied from memory by the server,
 * not typed by the Bot, so the Card cannot show different words from the Fact it would share.
 */
export type ApprovalFields = { fact_id: string; fact: string; topic: string };
/** Choice: a question with 2 to 6 short options. */
export type ChoiceFields = { question: string; options: string[] };

export const LIMITS = {
	factId: 100,
	fact: 500,
	question: 200,
	option: 40,
	minOptions: 2,
	maxOptions: 6,
} as const;

export class InvalidCard extends Error {}

/** Markup or control characters. A plain sentence has neither, so refusing them costs honest text nothing. */
const MARKUP = /[<>]|&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);|[\u0000-\u0008\u000b-\u001f\u007f]/i;

function text(name: string, value: unknown, max: number): string {
	if (typeof value !== "string") throw new InvalidCard(`${name} must be text.`);
	const clean = value.trim();
	if (clean === "") throw new InvalidCard(`${name} cannot be empty.`);
	if (clean.length > max) throw new InvalidCard(`${name} is ${clean.length} characters; the limit is ${max}.`);
	if (MARKUP.test(clean)) throw new InvalidCard(`${name} must be plain text, with no HTML or markup.`);
	return clean;
}

/** Fails unless the fields are exactly the ones the type allows. */
function exactly(fields: unknown, allowed: readonly string[]): Record<string, unknown> {
	if (typeof fields !== "object" || fields === null || Array.isArray(fields)) throw new InvalidCard("A Card's fields must be an object.");
	const record = fields as Record<string, unknown>;
	for (const key of Object.keys(record)) if (!allowed.includes(key)) throw new InvalidCard(`A Card of this type has no field "${key.slice(0, 40)}".`);
	for (const key of allowed) if (!Object.hasOwn(record, key)) throw new InvalidCard(`The field ${key} is required.`);
	return record;
}

/** Returns clean, trimmed fields of a Card, or throws `InvalidCard` saying what is wrong, in words a Bot can act on. */
export function validateFields(type: unknown, fields: unknown): ApprovalFields | ChoiceFields {
	if (type === "approval") {
		const f = exactly(fields, ["fact_id", "fact", "topic"]);
		if (!isTopic(f.topic)) throw new InvalidCard(`topic must be one of: ${TOPICS.map((t) => t.id).join(", ")}.`);
		return { fact_id: text("fact_id", f.fact_id, LIMITS.factId), fact: text("fact", f.fact, LIMITS.fact), topic: f.topic };
	}
	if (type === "choice") {
		const f = exactly(fields, ["question", "options"]);
		if (!Array.isArray(f.options) || f.options.length < LIMITS.minOptions || f.options.length > LIMITS.maxOptions) {
			throw new InvalidCard(`A choice needs ${LIMITS.minOptions} to ${LIMITS.maxOptions} options.`);
		}
		const options = f.options.map((o, i) => text(`Option ${i + 1}`, o, LIMITS.option));
		if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) throw new InvalidCard("Options must differ from each other.");
		return { question: text("question", f.question, LIMITS.question), options };
	}
	throw new InvalidCard(`Unknown Card type. Known types: ${CARD_TYPES.join(", ")}.`);
}
