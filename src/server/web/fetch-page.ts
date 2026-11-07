import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { isBlockedAddress } from "./addresses.ts";
import { htmlToText, plainText } from "./html-text.ts";
import { type WebPage, WebUnavailable } from "./web-access.ts";

const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 1_000_000;

/**
 * Looks a host up and refuses any answer that is not a public address. The check is in the lookup the connection
 * itself uses, so a name that resolves to a private address, or changes its answer between a check and the connection,
 * cannot get through.
 */
export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
	dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
		if (error) return callback(error, "", 0);
		const list = addresses as unknown as { address: string; family: number }[];
		const allowed = list.filter((a) => !isBlockedAddress(a.address));
		if (allowed.length === 0 || allowed.length !== list.length) {
			return callback(new WebUnavailable("That address is not allowed."), "", 0);
		}
		if (options.all) return (callback as unknown as (e: null, a: unknown) => void)(null, allowed);
		callback(null, allowed[0]!.address, allowed[0]!.family);
	});
};

type Response = { status: number; location?: string; type: string; body: Buffer };

function get(url: URL, lookup: LookupFunction): Promise<Response> {
	return new Promise((resolve, reject) => {
		const send = url.protocol === "https:" ? httpsRequest : httpRequest;
		const req = send(
			url,
			{ method: "GET", lookup, timeout: TIMEOUT_MS, headers: { "accept-encoding": "identity", accept: "text/html,text/plain", "user-agent": "Hamkey-Research/1.0" } },
			(res) => {
				const status = res.statusCode ?? 0;
				const type = String(res.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
				if (status >= 300 && status < 400) {
					res.resume();
					return resolve({ status, location: res.headers.location, type, body: Buffer.alloc(0) });
				}
				if (status !== 200 || (type !== "text/html" && type !== "text/plain")) {
					res.destroy();
					return reject(new WebUnavailable(status !== 200 ? `The page answered with status ${status}.` : "That link is not a web page or plain text."));
				}
				const chunks: Buffer[] = [];
				let size = 0;
				res.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size > MAX_BYTES) {
						// Enough to read; keep what came and stop the download.
						chunks.push(chunk.subarray(0, chunk.length - (size - MAX_BYTES)));
						res.destroy();
						resolve({ status, type, body: Buffer.concat(chunks) });
					} else chunks.push(chunk);
				});
				res.on("end", () => resolve({ status, type, body: Buffer.concat(chunks) }));
				res.on("error", () => resolve({ status, type, body: Buffer.concat(chunks) }));
			},
		);
		req.on("timeout", () => req.destroy(new WebUnavailable("The page took too long to answer.")));
		req.on("error", (error) => reject(error instanceof WebUnavailable ? error : new WebUnavailable("The page could not be reached.")));
		req.end();
	});
}

/** Refuses what cannot be fetched safely before any connection: other schemes, and addresses given as numbers. */
function check(url: URL): void {
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new WebUnavailable("Only http and https links can be opened.");
	if (url.username !== "" || url.password !== "") throw new WebUnavailable("Links with a login in them cannot be opened.");
	const host = url.hostname.replace(/^\[|\]$/g, "");
	// An address written out is checked here; a name is checked when it is looked up.
	if (isIP(host) !== 0 && isBlockedAddress(host)) throw new WebUnavailable("That address is not allowed.");
}

/**
 * Fetches one page for the Research Bot. It cannot reach Hamkey itself or the local network (Hamkey trusts localhost),
 * follows at most three redirects and checks every hop, and reads at most about 1 MB of text or HTML.
 */
export async function fetchPage(address: string, lookup: LookupFunction = publicOnlyLookup): Promise<WebPage> {
	let url: URL;
	try {
		url = new URL(address);
	} catch {
		throw new WebUnavailable("That is not a valid link.");
	}
	for (let hop = 0; ; hop++) {
		check(url);
		const res = await get(url, lookup);
		if (res.status >= 300 && res.status < 400) {
			if (hop === MAX_REDIRECTS || res.location === undefined) throw new WebUnavailable("The link redirects too many times.");
			try {
				url = new URL(res.location, url);
			} catch {
				throw new WebUnavailable("The link redirects somewhere invalid.");
			}
			continue;
		}
		const raw = res.body.toString("utf8");
		if (res.type === "text/plain") return { url: url.href, text: plainText(raw) };
		const { title, text } = htmlToText(raw);
		return { url: url.href, title, text };
	}
}
