import { createServer, type RequestListener, type Server } from "node:http";
import type { LookupFunction } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { isBlockedAddress } from "../src/server/web/addresses.ts";
import { fetchPage, publicOnlyLookup } from "../src/server/web/fetch-page.ts";
import { htmlToText } from "../src/server/web/html-text.ts";

describe("address checks", () => {
	it.each([
		"127.0.0.1", "127.8.9.10", "0.0.0.0", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
		"100.64.0.1", "100.127.255.255", "224.0.0.1", "239.255.255.250", "255.255.255.255",
		"::", "::1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1",
		"::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:192.168.0.5", "0:0:0:0:0:ffff:a00:1", "64:ff9b::7f00:1", "2002:7f00:1::1",
		"not an address", "",
	])("refuses %s", (address) => {
		expect(isBlockedAddress(address)).toBe(true);
	});

	it.each(["8.8.8.8", "93.184.216.34", "172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "2001:4860:4860::8888"])(
		"allows the public address %s",
		(address) => {
			expect(isBlockedAddress(address)).toBe(false);
		},
	);
});

describe("page text", () => {
	it("drops scripts, styles and tags, decodes entities and collapses space", () => {
		const html = `<html><head><title> Gift &amp; Garden </title><style>p{color:red}</style></head><body>
			<script>steal()</script><noscript>no js</noscript><!-- hidden -->
			<h1>Best   gifts</h1><p>Tea &lt;3 &#233; &#x41; &nbsp;done</p><div>Second<br>line</div></body></html>`;
		const page = htmlToText(html);
		expect(page.title).toBe("Gift & Garden");
		expect(page.text).toBe("Best gifts\nTea <3 é A done\nSecond\nline");
		for (const gone of ["steal", "color:red", "no js", "hidden", "<"]) expect(page.text.replace("<3", "")).not.toContain(gone);
	});

	it("cuts long pages", () => {
		const page = htmlToText(`<p>${"x".repeat(50_000)}</p>`, 1000);
		expect(page.text.length).toBeLessThan(1100);
		expect(page.text).toMatch(/\[cut off\]$/);
	});
});

describe("fetching a page", () => {
	let server: Server | undefined;
	let requests: string[] = [];
	afterEach(async () => {
		await new Promise((r) => (server ? server.close(r) : r(null)));
		server = undefined;
		requests = [];
	});
	/** Local only: the real checks refuse loopback, so the tests that need a reachable server skip the check. */
	const allowLoopback: LookupFunction = (_host, options, callback) =>
		options.all ? (callback as unknown as (e: null, a: unknown) => void)(null, [{ address: "127.0.0.1", family: 4 }]) : callback(null, "127.0.0.1", 4);

	async function serve(handler: RequestListener) {
		server = createServer((req, res) => {
			requests.push(req.url ?? "");
			handler(req, res);
		});
		await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
		// A name, not a literal address, because literal loopback addresses are refused before any lookup.
		return `http://localhost:${(server.address() as { port: number }).port}`;
	}

	it("never connects to Hamkey's own host, the local network, or a name that resolves there", async () => {
		const base = await serve((_req, res) => res.end("secret"));
		await expect(fetchPage(`${base.replace("localhost", "127.0.0.1")}/api/me`)).rejects.toThrow(/not allowed/);
		await expect(fetchPage(base)).rejects.toThrow(/not allowed/);
		for (const url of ["http://[::1]/", "http://192.168.1.1/", "http://10.0.0.1/", "http://169.254.169.254/", "http://[::ffff:127.0.0.1]/", "http://0.0.0.0/", "http://2130706433/"]) {
			await expect(fetchPage(url)).rejects.toThrow(/not allowed/);
		}
		expect(requests).toEqual([]);
		await expect(new Promise((res, rej) => publicOnlyLookup("localhost", {}, (e, a) => (e ? rej(e) : res(a))))).rejects.toThrow();
	});

	it("opens only http and https links", async () => {
		for (const url of ["file:///etc/passwd", "ftp://example.com/", "javascript:alert(1)", "not a url", "http://user:pw@example.com/"]) {
			await expect(fetchPage(url)).rejects.toThrow();
		}
	});

	it("reads HTML and plain text, and refuses other types", async () => {
		const base = await serve((req, res) => {
			if (req.url === "/html") res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<title>T</title><p>Hello <b>web</b></p>");
			else if (req.url === "/text") res.writeHead(200, { "content-type": "text/plain" }).end("  plain words ");
			else res.writeHead(200, { "content-type": "application/pdf" }).end("%PDF");
		});
		expect(await fetchPage(`${base}/html`, allowLoopback)).toEqual({ url: `${base}/html`, title: "T", text: "Hello web" });
		expect(await fetchPage(`${base}/text`, allowLoopback)).toEqual({ url: `${base}/text`, text: "plain words" });
		await expect(fetchPage(`${base}/pdf`, allowLoopback)).rejects.toThrow(/not a web page/);
	});

	it("asks for an uncompressed body", async () => {
		let encoding: string | undefined;
		const base = await serve((req, res) => {
			encoding = req.headers["accept-encoding"] as string;
			res.writeHead(200, { "content-type": "text/plain" }).end("ok");
		});
		await fetchPage(base, allowLoopback);
		expect(encoding).toBe("identity");
	});

	it("follows at most three redirects", async () => {
		// `/end/<last>/<n>` redirects to the next number until it reaches <last>.
		const base = await serve((req, res) => {
			const [, , last, n] = req.url!.split("/").map(Number);
			if (n! < last!) res.writeHead(302, { location: `/end/${last}/${n! + 1}` }).end();
			else res.writeHead(200, { "content-type": "text/plain" }).end(`at ${n}`);
		});
		expect((await fetchPage(`${base}/end/3/0`, allowLoopback)).text).toBe("at 3");
		await expect(fetchPage(`${base}/end/4/0`, allowLoopback)).rejects.toThrow(/redirects/);
	});

	it("re-checks the address on every redirect hop", async () => {
		// The first host is allowed by the lookup; the redirect target is a literal private address, refused before connecting.
		const base = await serve((_req, res) => res.writeHead(302, { location: "http://169.254.169.254/latest" }).end());
		await expect(fetchPage(base, allowLoopback)).rejects.toThrow(/not allowed/);
		expect(requests).toEqual(["/"]);
	});

	it("reads at most about 1 MB", async () => {
		const base = await serve((_req, res) => res.writeHead(200, { "content-type": "text/plain" }).end("a".repeat(3_000_000)));
		const page = await fetchPage(base, allowLoopback);
		expect(page.text.length).toBeLessThanOrEqual(20_020);
	});
});
