import { type SearchResult, type WebAccess, WebUnavailable } from "./web-access.ts";
import { fetchPage } from "./fetch-page.ts";
import { htmlToText } from "./html-text.ts";

/** Searches with the Brave Search API and opens pages with `fetchPage`. */
export function productionWeb(env: NodeJS.ProcessEnv = process.env): WebAccess {
	const key = env.BRAVE_SEARCH_API_KEY;
	return {
		async search(query): Promise<SearchResult[]> {
			if (!key) throw new WebUnavailable("Web search is not set up on this server.");
			let response: Response;
			try {
				response = await fetch(`https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query })}`, {
					headers: { "x-subscription-token": key, accept: "application/json" },
					signal: AbortSignal.timeout(10_000),
				});
			} catch {
				throw new WebUnavailable("The search service could not be reached.");
			}
			if (!response.ok) throw new WebUnavailable(`The search service answered with status ${response.status}.`);
			const body = (await response.json().catch(() => ({}))) as { web?: { results?: { url?: unknown; title?: unknown; description?: unknown }[] } };
			return (body.web?.results ?? [])
				.filter((r) => typeof r.url === "string")
				.map((r) => ({ url: r.url as string, title: htmlToText(String(r.title ?? "")).text, snippet: htmlToText(String(r.description ?? "")).text }));
		},
		open: (url) => fetchPage(url),
	};
}
