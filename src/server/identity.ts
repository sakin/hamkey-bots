import type { IncomingHttpHeaders } from "node:http";
import type { Member } from "./members.ts";

/** Tailscale Serve sets this header after authenticating the caller. It is trustworthy only because we listen on localhost. */
export const TAILSCALE_LOGIN_HEADER = "tailscale-user-login";
/** Development only: lets the Operator act as either Member from one machine. */
export const DEV_MEMBER_HEADER = "x-hamkey-dev-member";

export type IdentityOptions = { members: readonly Member[]; devIdentity?: string };

/** Resolve the current Member from request headers, or undefined to refuse. */
export function resolveMember(headers: IncomingHttpHeaders, { members, devIdentity }: IdentityOptions): Member | undefined {
	if (devIdentity !== undefined) {
		const asked = headers[DEV_MEMBER_HEADER];
		const id = typeof asked === "string" && asked !== "" ? asked : devIdentity;
		return members.find((m) => m.id === id);
	}
	const login = headers[TAILSCALE_LOGIN_HEADER];
	if (typeof login !== "string" || login === "") return undefined;
	return members.find((m) => m.tailscaleLogin.toLowerCase() === login.toLowerCase());
}
