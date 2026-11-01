import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
	root: "src/web",
	plugins: [tailwindcss(), svelte()],
	build: { outDir: "../../dist/web", emptyOutDir: true },
	server: { proxy: { "/api": "http://127.0.0.1:3000" } },
});
