import { appendFile, access } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

/** Names of the two test tools, which a test adds to every Bot's access. */
export const CRASH_TOOLS = ["effect_safe", "effect_unsafe"];

const exists = (file: string) => access(file).then(() => true, () => false);

/** Waits until a test creates `file`. A test that never does leaves the call hanging, which is the point: it is killed there. */
export async function until(file: string) {
	while (!(await exists(file))) await new Promise((r) => setTimeout(r, 25));
}

/**
 * Two tools for crash tests, identical except for `replay`. Each records that it ran (one line in `effects-<name>.log`
 * in the control folder) and then holds until `release` appears there, so a test can kill the server while the call is
 * running. Test-only: nothing in the product installs them.
 */
export function crashTools(control: string) {
	const make = (name: string, replay?: "safe") =>
		defineTool({
			name,
			description: "A test tool that records each run and then waits.",
			parameters: Type.Object({}),
			...(replay === undefined ? {} : { replay }),
			async execute() {
				await appendFile(join(control, `effects-${name}.log`), "ran\n");
				await until(join(control, "release"));
				return { output: [{ type: "text" as const, text: `${name} finished` }] };
			},
		});
	return defineExtension({ name: "crash-tools", tools: [make("effect_safe", "safe"), make("effect_unsafe")] });
}
