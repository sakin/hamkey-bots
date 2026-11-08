/**
 * Browser smoke test of the main flow. It is a script, not part of `vitest run`, so the normal suite stays fast and needs
 * no browser. Run it with `npm run test:smoke`. It builds the web app, starts a real Hamkey server in this process on a
 * random port (faux model, temporary data folder, development identity, the built app served from `dist/web`), and drives
 * a real browser through `agent-browser`: see the Bots, talk to the Primary Bot, open the shared Meal Planner, tap a
 * waiting Card. It exits non-zero on any failure, and always closes its browser session and stops its server.
 */
import { execFile, execFileSync } from "node:child_process";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { promisify } from "node:util";
import { startHamkey } from "../harness.ts";
import { call, say } from "../say.ts";
import { people, tell } from "../scenario.ts";

const run = promisify(execFile);
const ROOT = new URL("../..", import.meta.url).pathname;
const FACT = "Ann is vegetarian";
const REPLY = "Hello Ann, I am your Primary Bot and I am running on a scripted model.";

/** The CLI is pinned by mise; use it from the PATH when mise has put it there, otherwise through `mise exec`. */
const cli = (() => {
	try {
		execFileSync("agent-browser", ["--version"], { stdio: "ignore" });
		return { cmd: "agent-browser", prefix: [] as string[] };
	} catch {
		return { cmd: "mise", prefix: ["exec", "--", "agent-browser"] };
	}
})();
const session = (await run(cli.cmd, [...cli.prefix, "session", "id", "--scope", "worktree", "--prefix", "smoke"], { cwd: ROOT })).stdout.trim();

/** One agent-browser command in this script's own session; resolves with its output. */
async function browser(...args: string[]): Promise<string> {
	const { stdout } = await run(cli.cmd, [...cli.prefix, "--session", session, ...args], { cwd: ROOT, timeout: 60_000 });
	return stdout;
}
const pageText = () => browser("get", "text", "body");
async function expectText(text: string, what: string) {
	await browser("wait", "--text", text);
	console.log(`ok   ${what}`);
}
function check(condition: boolean, what: string) {
	if (!condition) throw new Error(`FAILED ${what}`);
	console.log(`ok   ${what}`);
}

let hamkey: Awaited<ReturnType<typeof startHamkey>> | undefined;
try {
	console.log("Building the web app...");
	execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "ignore" });
	// Development identity: the browser needs no Tailscale header and acts as Ann.
	hamkey = await startHamkey({ devIdentity: "ann", webDir: `${ROOT}dist/web` });
	const h = hamkey;
	const { ann } = people(h);

	// A waiting Card for Ann: she told her Primary Bot a fact, and the Bot suggested sharing it.
	const id = await tell(h, ann, FACT);
	await say(h, ann.client, "Share that under dietary needs", [call("suggest_sharing", { fact_id: id, topic: "dietary-needs" })]);
	check((await h.cards.waitingFor("ann")).length === 1, "a Card is waiting for Ann");

	await browser("open", `http://127.0.0.1:${h.port}/`);
	await expectText("Research Bot", "the app opens and lists the Bots");
	const list = await pageText();
	for (const name of ["Primary Bot", "Research Bot", "Meal Planner"]) check(list.includes(name), `the Bot list has ${name}`);

	// Talk to the Primary Bot and see the scripted reply.
	h.faux.setResponses([fauxAssistantMessage([fauxText(REPLY)])]);
	await browser("find", "role", "button", "click", "--name", "Primary Bot");
	await browser("find", "label", "Message", "fill", "Hello there");
	await browser("find", "role", "button", "click", "--name", "Send");
	await expectText(REPLY, "the Primary Bot's scripted reply appears");

	// The Meal Planner is a shared thread and says so.
	await browser("find", "role", "button", "click", "--name", "Meal Planner");
	await expectText("Shared thread", "the Meal Planner shows its Shared badge and shared-thread note");
	check((await pageText()).includes("Shared"), "the Shared badge is on the page");

	// Tap the waiting Card in the Primary Bot's thread.
	await browser("find", "role", "button", "click", "--name", "Primary Bot");
	await expectText("suggests sharing", "the waiting Approval Card is shown");
	await browser("find", "role", "button", "click", "--name", "Approve");
	await expectText("Shared", "tapping Approve settles the Card");
	check((await h.memory.listShared(ann.scope, "dietary-needs")).some((f) => f.text === FACT), "the fact is now shared under Dietary needs");
	check((await h.cards.waitingFor("ann")).length === 0, "no Card waits for Ann any more");
	console.log("Smoke test passed.");
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
} finally {
	await browser("close").catch(() => {});
	await hamkey?.stop().catch(() => {});
	process.exit();
}
