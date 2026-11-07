/** One hit from a web search. All three fields are text from the web, so none of them is to be trusted. */
export type SearchResult = { url: string; title: string; snippet: string };

/** A page, reduced to text. */
export type WebPage = { url: string; title?: string; text: string };

/**
 * The only way Hamkey reaches the web (ADR 0004). Only the Research Bot's tools hold one. Tests replace it with a fake
 * that serves scripted pages, so no test touches the network.
 */
export interface WebAccess {
	search(query: string): Promise<SearchResult[]>;
	open(url: string): Promise<WebPage>;
}

/** The web cannot be used right now; the message is plain words, safe to show the Bot and the Member. */
export class WebUnavailable extends Error {}
