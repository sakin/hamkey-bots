import { resolve } from "node:path";

export type Config = {
	port: number;
	/** Application data lives here, outside git: members, the conversation store, thread index. */
	dataDir: string;
	production: boolean;
	/** Development only: the Member id every request is treated as, unless the request names another. */
	devIdentity?: string;
	model: { provider: string; modelId: string };
	/** Directory of the built web app; absent in tests. */
	webDir?: string;
};

export const DEFAULT_MODEL = "anthropic/claude-sonnet-5.5";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const production = env.NODE_ENV === "production";
	const devIdentity = env.HAMKEY_DEV_IDENTITY || undefined;
	if (production && devIdentity !== undefined) {
		throw new Error("HAMKEY_DEV_IDENTITY must not be set in production: it would let anyone act as a Member.");
	}
	return {
		port: Number(env.PORT ?? 3000),
		dataDir: resolve(env.HAMKEY_DATA_DIR ?? "data"),
		production,
		devIdentity,
		model: { provider: "openrouter", modelId: env.HAMKEY_MODEL || DEFAULT_MODEL },
		webDir: resolve(env.HAMKEY_WEB_DIR ?? "dist/web"),
	};
}
