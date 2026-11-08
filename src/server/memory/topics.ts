/**
 * The Topics a Fact can be shared under. A fixed server list for v1, so a Bot or a Card cannot invent one; the Exposure
 * List (a later issue) is keyed by these ids.
 */
export const TOPICS = [
	{ id: "dietary-needs", label: "Dietary needs" },
	{ id: "evening-availability", label: "Evening availability" },
] as const;

export type TopicId = (typeof TOPICS)[number]["id"];

export const isTopic = (value: unknown): value is TopicId => TOPICS.some((t) => t.id === value);

export const topicLabel = (id: string): string => TOPICS.find((t) => t.id === id)?.label ?? id;
