// Throwaway spike: proves the Pi Durable behaviour the v1 tickets rely on, with the faux model.
// Run: SPIKE_DIR=<empty dir> mise exec -- node spikes/pi-durable/spike.mjs
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage as msg, fauxProvider, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { configure, createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const dir = process.env.SPIKE_DIR;
if (!dir) throw new Error("set SPIKE_DIR");

const results = [];
const check = (name, ok, detail = "") => {
	results.push(ok);
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`);
};
const text = (m) =>
	typeof m.content === "string" ? m.content : m.content.map((c) => c.text ?? (c.type === "toolCall" ? `[call ${c.name}]` : "")).join("");
const allText = (c) => JSON.stringify(c);
const toolResults = (c) => c.messages.filter((m) => m.role === "toolResult").map((m) => ({ text: text(m), isError: m.isError }));

function setup(tools, settings = {}, storage = new MemoryStorage()) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(defineExtension({ name: "spike", tools }));
	const model = faux.getModel();
	return { faux, models, registry, settings, storage, modelRef: { provider: model.provider, modelId: model.id } };
}
const open = (s) => Harness.open(s.storage, { models: s.models, registry: s.registry, settings: s.settings }, ctx);
const ownerless = (h, s, agent) => h.createConversation({ ownership: { kind: "ownerless" }, agent: { model: s.modelRef, ...agent } }, ctx);
const ask = async (c, content, extra = {}) => (await c.submit({ type: "input", content, ...extra }, ctx)).wait(ctx);

// 1. Scope binding: one tool, scope worked out from the conversation.
{
	const scopes = new Map();
	const memory = { alice: [], bob: [] };
	const remember = defineTool({
		name: "remember",
		description: "Save a fact",
		parameters: Type.Object({ fact: Type.String() }),
		execute: async (args, api) => {
			memory[scopes.get(api.conversationId)].push(args.fact);
			return { output: [{ type: "text", text: "saved" }] };
		},
	});
	const s = setup([remember]);
	const h = await open(s);
	const a = await ownerless(h, s, { tools: [remember] });
	const b = await ownerless(h, s, { tools: [remember] });
	const none = await ownerless(h, s, { tools: [] });
	scopes.set(a.id, "alice");
	scopes.set(b.id, "bob");
	const call = (fact, extra = {}) => [msg(fauxToolCall("remember", { fact, ...extra }), { stopReason: "toolUse" }), msg("done")];
	s.faux.setResponses(call("a-fact"));
	await ask(a, "x");
	// The model tries to name the other scope; the schema has no such argument.
	s.faux.setResponses(call("b-fact", { scope: "alice" }));
	await ask(b, "x");
	check("1a same tool, scope comes from the conversation", memory.alice.join() === "a-fact" && memory.bob.join() === "b-fact", JSON.stringify(memory));
	let seen;
	s.faux.setResponses([
		msg(fauxToolCall("remember", { fact: "sneaky" }), { stopReason: "toolUse" }),
		(c) => ((seen = c), msg("done")),
	]);
	await ask(none, "x");
	check("1b a tool not selected cannot run, even if the model calls it", !memory.alice.includes("sneaky") && !memory.bob.includes("sneaky") && toolResults(seen)[0]?.isError === true, JSON.stringify(toolResults(seen)));
	await h.close(ctx);
}

// 2. Ask: a turn run from inside a tool holds only what we give it.
{
	const contexts = {};
	let leaked = 0;
	const remember = defineTool({
		name: "remember",
		description: "Save a fact",
		parameters: Type.Object({ fact: Type.String() }),
		execute: async () => (leaked++, { output: [{ type: "text", text: "saved" }] }),
	});
	const makeAsk = (name, restrict) =>
		defineTool({
			name,
			description: "Ask a Primary Bot",
			parameters: Type.Object({ question: Type.String() }),
			replay: "safe",
			execute: async (args, api, context) => {
				const child = await api.commit(async (tx) => {
					const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
					if (restrict) await configure(tx, created.id, { tools: [], instructions: "Answer only from the facts given." });
					return created.id;
				}, context);
				const conv = await api.conversation(child, context);
				const prompt = `Topic: dietary needs\nApproved facts: no peanuts\nQuestion: ${args.question}`;
				const settled = await (await conv.submit({ type: "input", content: prompt }, context)).wait(context);
				return { output: [{ type: "text", text: settled.status }] };
			},
		});
	const unrestricted = makeAsk("ask_unrestricted", false);
	const restricted = makeAsk("ask_restricted", true);
	const s = setup([remember, unrestricted, restricted]);
	const h = await open(s);
	const parent = await ownerless(h, s, { tools: [remember, unrestricted, restricted], instructions: "PARENT-INSTRUCTIONS" });
	const run = (tool, key) =>
		s.faux.setResponses([
			(c) => ((contexts[`${key}Parent`] = c), msg(fauxToolCall(tool, { question: "any food limits?" }), { stopReason: "toolUse" })),
			(c) => ((contexts[key] = c), msg(fauxToolCall("remember", { fact: "x" }), { stopReason: "toolUse" })),
			(c) => ((contexts[`${key}After`] = c), msg("no peanuts")),
			msg("done"),
		]);
	run("ask_unrestricted", "copy");
	const first = await Promise.race([ask(parent, "SECRET-IN-PARENT-THREAD"), sleep(8000, "timeout")]);
	check("2a a tool can run a nested conversation and wait, no deadlock", first !== "timeout" && first.status === "done", first.status ?? first);
	const copyTools = (contexts.copy?.tools ?? []).map((t) => t.name);
	const offered = (c) => (c?.messages ?? []).flatMap((m) => m.toolsAdded ?? []).map((t) => t.name);
	check("2b0 the request exposes offered tools, and the parent's are listed", offered(contexts.copyParent).includes("remember"), JSON.stringify(offered(contexts.copyParent)));
	check("2b1 the unrestricted child is offered the asker's tools", offered(contexts.copy).includes("remember"), JSON.stringify(offered(contexts.copy)));
	check("2b2 control: parent instructions are visible to this check", allText(contexts.copyParent).includes("PARENT-INSTRUCTIONS"));
	check("2b CONFIRMS RISK: an owned conversation runs the asker's tools unless restricted", leaked === 1, `child remember runs: ${leaked}`);
	const leakedBefore = leaked;
	run("ask_restricted", "strict");
	const second = await Promise.race([ask(parent, "SECRET-AGAIN"), sleep(8000, "timeout")]);
	const c = contexts.strict;
	check("2c the restricted Ask finished and is offered no tools", second !== "timeout" && second.status === "done" && offered(c).length === 0, JSON.stringify(offered(c)));
	check("2d the Ask turn sees no parent thread or instructions", !!c && !allText(c).includes("SECRET") && !allText(c).includes("PARENT-INSTRUCTIONS"), allText(c ?? {}).slice(0, 300));
	check("2e the Ask turn sees the approved fact", !!c && allText(c).includes("no peanuts"));
	check("2f explicit tools:[] refuses the same tool call in the Ask turn", leaked === leakedBefore, JSON.stringify(toolResults(contexts.strictAfter ?? { messages: [] })));
	await h.close(ctx);
}

// 3. Collect: messages sent during a run reach the next reply together, with senders.
{
	const s = setup([], { followUpMode: "all", afterFailedRun: "continue" });
	const h = await open(s);
	const thread = await ownerless(h, s, { tools: [] });
	let release;
	const gate = new Promise((r) => (release = r));
	let second;
	s.faux.setResponses([
		async () => (await gate, msg("first reply")),
		(c) => ((second = c), msg("collected reply")),
	]);
	const say = (author, words) =>
		thread.submit({ type: "input", content: `${author}: ${words}`, entry: { kind: "hamkey.message", data: { author, words } } }, ctx);
	const m1 = await say("alice", "plan dinner");
	await sleep(100);
	const m2 = await say("bob", "no fish");
	const m3 = await say("alice", "and cheap");
	release();
	await Promise.all([m1.wait(ctx), m2.wait(ctx), m3.wait(ctx)]);
	const latest = second ? allText(second) : "";
	check("3a both queued messages reach one reply", s.faux.state.callCount === 2 && latest.includes("bob: no fish") && latest.includes("alice: and cheap"), `model calls: ${s.faux.state.callCount}`);
	const view = await thread.viewState(ctx);
	const kinds = view.value?.entries?.filter?.((e) => e.kind === "hamkey.message").length ?? view.get?.().entries.filter((e) => e.kind === "hamkey.message").length;
	check("3b sender labels are stored on entries", kinds === 3, `labelled entries: ${kinds}`);
	view.dispose();

	let releaseFail;
	const failGate = new Promise((r) => (releaseFail = r));
	let afterFail;
	s.faux.setResponses([
		async () => (await failGate, msg("", { stopReason: "error", errorMessage: "model exploded" })),
		(c) => ((afterFail = c), msg("recovered")),
	]);
	const m4 = await say("alice", "this run fails");
	await sleep(100);
	const m5 = await say("bob", "still here");
	releaseFail();
	const [r4, r5] = await Promise.race([Promise.all([m4.wait(ctx), m5.wait(ctx)]), sleep(15000).then(() => ["timeout", "timeout"])]);
	check("3c a failed run does not strand the queued message", r5 !== "timeout" && r5.status === "done" && !!afterFail, `failed run: ${r4.status ?? r4}, queued: ${r5.status ?? r5}`);
	await h.close(ctx);
}

// 4. Restart: kill -9 mid-tool, then reopen.
{
	const db = join(dir, "crash.sqlite");
	const child = spawn(process.execPath, [new URL("./crash-child.mjs", import.meta.url).pathname], { env: { ...process.env, SPIKE_DIR: dir }, stdio: "inherit" });
	const ready = join(dir, "crash.json");
	for (let i = 0; i < 100 && !existsSync(join(dir, "both-running")); i++) await sleep(100);
	const reached = existsSync(join(dir, "both-running"));
	child.kill("SIGKILL");
	await sleep(200);
	check("4a process killed with both tools mid-run", reached);
	const { conversationId, submissionId, requestId } = JSON.parse(readFileSync(ready, "utf8"));
	const runs = { unsafe: 0, safe: 0 };
	const unsafe = defineTool({ name: "slow_unsafe", description: "x", parameters: Type.Object({}), execute: async () => (runs.unsafe++, { output: [{ type: "text", text: "unsafe ran" }] }) });
	const safe = defineTool({ name: "slow_safe", description: "x", parameters: Type.Object({}), replay: "safe", execute: async () => (runs.safe++, { output: [{ type: "text", text: "safe ran" }] }) });
	const s = setup([unsafe, safe], {}, await openNodeSqliteStorage(db));
	let resumed;
	s.faux.setResponses([(c) => ((resumed = c), msg("finished after restart"))]);
	const h = await open(s);
	h.resume();
	const conv = await h.conversation(conversationId, ctx);
	const settled = await Promise.race([(await h.submission(submissionId, ctx)).wait(ctx), sleep(8000, "timeout")]);
	check("4b the interrupted run finishes after reopen", settled !== "timeout" && settled.status === "done", settled.status ?? settled);
	const tr = resumed ? toolResults(resumed) : [];
	check("4c unsafe tool did not rerun; the model was told", runs.unsafe === 0 && tr.some((r) => r.isError), JSON.stringify(tr));
	check("4d safe tool reran", runs.safe === 1, `runs: ${runs.safe}`);
	const before = s.faux.state.callCount;
	const again = await conv.submit({ type: "input", content: "go", requestId }, ctx);
	check("4e same requestId does not submit twice", again.id === submissionId && s.faux.state.callCount === before, again.id);
	await h.close(ctx);
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
