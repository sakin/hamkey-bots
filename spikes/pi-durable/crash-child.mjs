// Throwaway spike helper: starts a run, then hangs inside two tools until the parent kills this process.
import { writeFileSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage as msg, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const dir = process.env.SPIKE_DIR;
const hang = (name) => async () => {
	writeFileSync(join(dir, name), "");
	if (existsSync(join(dir, "slow_unsafe")) && existsSync(join(dir, "slow_safe"))) writeFileSync(join(dir, "both-running"), "");
	await sleep(60_000);
	return {};
};
const unsafe = defineTool({ name: "slow_unsafe", description: "x", parameters: Type.Object({}), execute: hang("slow_unsafe") });
const safe = defineTool({ name: "slow_safe", description: "x", parameters: Type.Object({}), replay: "safe", execute: hang("slow_safe") });

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const registry = createRegistry();
registry.install(defineExtension({ name: "spike", tools: [unsafe, safe] }));
const model = faux.getModel();
const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "crash.sqlite")), { models, registry }, ctx);
const conv = await harness.createConversation(
	{ ownership: { kind: "ownerless" }, agent: { model: { provider: model.provider, modelId: model.id }, tools: [unsafe, safe] } },
	ctx,
);
faux.setResponses([msg([fauxToolCall("slow_unsafe", {}), fauxToolCall("slow_safe", {})], { stopReason: "toolUse" })]);
const requestId = "spike-request";
const submission = await conv.submit({ type: "input", content: "go", requestId }, ctx);
writeFileSync(join(dir, "crash.json"), JSON.stringify({ conversationId: conv.id, submissionId: submission.id, requestId }));
await sleep(60_000);
