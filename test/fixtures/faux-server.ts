/**
 * Hamkey in its own process, so a test can kill it for real (SIGKILL: no close, no cleanup). Run with tsx:
 * `tsx test/fixtures/faux-server.ts <config.json>`. It is the same server as `startHamkey`, with a scripted model.
 *
 * The script is a list of model responses, one per model request in the order they are made. A step can drop a marker
 * (`reached`) when the request arrives, and then hold (`hold`) until a file named `release` appears in the control
 * folder, so a test knows the server is mid-run before it kills it. Every request's messages are appended to
 * `prompts.jsonl` there, which is what the model was shown.
 */
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { startHamkey } from "../harness.ts";
import { CRASH_TOOLS, crashTools, until } from "./crash-tools.ts";

export type Step = { call?: [string, Record<string, unknown>]; text?: string; reached?: string; hold?: boolean };
export type ServerConfig = { dataDir: string; control: string; script: Step[]; extraBots?: object[]; restartLimit?: number };

const config = JSON.parse(await readFile(process.argv[2]!, "utf8")) as ServerConfig;

const respond = (step: Step) => async (context: { messages: unknown[] }) => {
	await appendFile(join(config.control, "prompts.jsonl"), JSON.stringify(context.messages) + "\n");
	if (step.reached !== undefined) await writeFile(join(config.control, `reached-${step.reached}`), "");
	if (step.hold) await until(join(config.control, "release"));
	return step.call !== undefined
		? fauxAssistantMessage([fauxToolCall(step.call[0], step.call[1] as never)], { stopReason: "toolUse" })
		: fauxAssistantMessage([fauxText(step.text ?? "Done.")]);
};

const hamkey = await startHamkey({
	dataDir: config.dataDir,
	extraBots: config.extraBots,
	restartLimit: config.restartLimit,
	extensions: [crashTools(config.control)],
	extraTools: CRASH_TOOLS,
});
// Spare answers after the script, as in `say()`.
hamkey.faux.setResponses([...config.script, ...Array.from({ length: 4 }, () => ({ text: "Done." }))].map(respond) as never);
process.stdout.write(`LISTENING ${hamkey.port}\n`);
