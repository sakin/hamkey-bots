import { isIP } from "node:net";

/** The four parts of an IPv4 address, or undefined if the text is not one. */
function v4(address: string): number[] | undefined {
	const parts = address.split(".");
	if (parts.length !== 4) return undefined;
	const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
	return nums.every((n) => n >= 0 && n <= 255) ? nums : undefined;
}

function blockedV4([a, b, c]: number[]): boolean {
	return (
		a === 0 || // unspecified, "this network"
		a === 10 || // private
		a === 127 || // loopback
		(a === 100 && b! >= 64 && b! <= 127) || // CGNAT, which Tailscale also uses
		(a === 169 && b === 254) || // link-local
		(a === 172 && b! >= 16 && b! <= 31) || // private
		(a === 192 && b === 0 && c === 0) || // IETF protocol assignments
		(a === 192 && b === 168) || // private
		(a === 198 && (b === 18 || b === 19)) || // benchmarking
		a! >= 224 // multicast, reserved, broadcast
	);
}

/** Expands an IPv6 address into eight 16-bit groups, or undefined if it is malformed. */
function groups(address: string): number[] | undefined {
	let text = address.toLowerCase();
	const zone = text.indexOf("%");
	if (zone !== -1) text = text.slice(0, zone);
	// A trailing dotted IPv4 part stands for the last two groups.
	const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
	if (dotted) {
		const ip = v4(dotted[2]!);
		if (ip === undefined) return undefined;
		text = `${dotted[1]}${((ip[0]! << 8) | ip[1]!).toString(16)}:${((ip[2]! << 8) | ip[3]!).toString(16)}`;
	}
	const halves = text.split("::");
	if (halves.length > 2) return undefined;
	const parse = (s: string) => (s === "" ? [] : s.split(":"));
	const head = parse(halves[0]!);
	const tail = halves.length === 2 ? parse(halves[1]!) : [];
	const missing = 8 - head.length - tail.length;
	if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
	const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
	const nums = all.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
	return nums.every((n) => !Number.isNaN(n)) && nums.length === 8 ? nums : undefined;
}

/**
 * Whether Hamkey must refuse to connect to this address: loopback, private, link-local, CGNAT, multicast, unspecified
 * and the like, in IPv4 and IPv6 (including IPv4 inside IPv6). Hamkey trusts localhost and the LAN, so a page link
 * must never reach them. Anything that is not a valid address is refused too.
 */
export function isBlockedAddress(address: string): boolean {
	const kind = isIP(address);
	if (kind === 4) return blockedV4(v4(address)!);
	if (kind !== 6) return true;
	const g = groups(address);
	if (g === undefined) return true;
	const embedded = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
	// ::ffff:a.b.c.d (IPv4-mapped), ::a.b.c.d (compatible) and 64:ff9b::/96 (NAT64) carry an IPv4 address.
	if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return blockedV4(embedded(g[6]!, g[7]!));
	if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return blockedV4(embedded(g[6]!, g[7]!));
	// 2002::/16 (6to4) carries one in its second and third groups.
	if (g[0] === 0x2002) return blockedV4(embedded(g[1]!, g[2]!));
	if (g.every((x) => x === 0) || (g.slice(0, 7).every((x) => x === 0) && g[7] === 1)) return true; // :: and ::1
	const first = g[0]!;
	return (
		(first & 0xfe00) === 0xfc00 || // unique local
		(first & 0xffc0) === 0xfe80 || // link-local
		(first & 0xffc0) === 0xfec0 || // site-local
		(first & 0xff00) === 0xff00 || // multicast
		first === 0x2001 && g[1] === 0x0db8 // documentation
	);
}
