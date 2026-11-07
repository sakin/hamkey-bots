const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
		if (name[0] === "#") {
			const code = name[1]!.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
			return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
		}
		return ENTITIES[name.toLowerCase()] ?? whole;
	});
}

const tidy = (s: string) => decode(s).replace(/\s+/g, " ").trim();

/** Turns HTML into plain text and a title, simply: script, style and the like go, tags go, entities are decoded. */
export function htmlToText(html: string, cap = 20_000): { title?: string; text: string } {
	const title = tidy(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]*>/g, "") ?? "");
	const body = html
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<(script|style|noscript|template|svg|head|title)\b[\s\S]*?<\/\1\s*>/gi, " ")
		.replace(/<\/?(p|div|br|li|ul|ol|h[1-6]|tr|table|section|article|header|footer|blockquote|pre)\b[^>]*>/gi, "\n")
		.replace(/<[^>]*>/g, " ");
	const text = decode(body)
		.split("\n")
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter((line) => line !== "")
		.join("\n");
	return { title: title === "" ? undefined : title, text: text.length > cap ? `${text.slice(0, cap)}\n[cut off]` : text };
}

/** Plain text is only trimmed and capped. */
export function plainText(text: string, cap = 20_000): string {
	const t = text.replace(/\r\n?/g, "\n").trim();
	return t.length > cap ? `${t.slice(0, cap)}\n[cut off]` : t;
}
