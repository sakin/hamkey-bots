import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";

// Ports come from the environment so several worktrees can run side by side (see bin/worktree-setup).
// `.env.local` in the repo root holds them; real environment variables win.
export default defineConfig(({ mode }) => {
	const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
	return {
		root: "src/web",
		plugins: [tailwindcss(), svelte()],
		build: { outDir: "../../dist/web", emptyOutDir: true },
		server: {
			port: Number(env.HAMKEY_WEB_PORT ?? 5173),
			strictPort: true,
			// Only /api/ paths: a bare "/api" would also catch the app's own /api.ts module.
			proxy: { "^/api/": `http://127.0.0.1:${env.PORT ?? 3000}` },
		},
	};
});
