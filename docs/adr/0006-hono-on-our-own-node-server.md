# Hono on our own Node server, not SvelteKit

Hamkey's HTTP layer is [Hono](https://hono.dev) with `@hono/node-server`, serving a plain Svelte 5 and Vite app. We considered SvelteKit with `adapter-node` as the single server and rejected it.

Why not SvelteKit:

- Pi Durable allows one process to own a storage at a time, with no cross-process locking. SvelteKit's dev server re-runs server modules, which could open the harness twice on one SQLite file and run `resume()` twice. Our own `main.ts` owns startup and shutdown, and `tsx watch` restarts the whole process.
- Resume, sleeping tasks, push, the spend guard and Asks run with no request attached. SvelteKit has nowhere to host them, so they would live in a hand-made singleton outside the framework anyway.
- The outer-edge test harness (issue #2) injects the faux model and temporary storage into a real server on a random port. A built SvelteKit app takes only environment variables.
- We choose the bind address ourselves (`listenLocal`, 127.0.0.1) rather than relying on `HOST`. A mistake there would expose the forgeable Tailscale identity header.
- Every screen is behind identity and driven by a live stream, so SSR adds nothing.

Why Hono over bare `node:http`: v1 adds many routes. Hono gives one identity middleware so every API route resolves the Member first, plus routing, body limits and an SSE helper, while leaving `main.ts`, the Pi Durable boundary (ADR 0001) and the harness as they were.

Rules that follow:

- Pin `hono` and `@hono/node-server` exactly, and take releases at least two weeks old. Hono releases very often and has one npm maintainer.
- The API is a sub-app that ends in its own JSON 404, mounted before the SPA fallback, so an unknown `/api` path never returns `index.html`.
- An SSE handler stays pending until the client aborts, then releases its subscription.
- `createAdaptorServer` runs with `overrideGlobalObjects: false`, so pi-ai's outbound `fetch` keeps the global `Request` and `Response`.

Revisit SvelteKit if we later need SSR or form actions, or if the frontend grows many screens. SvelteKit in SPA mode with `adapter-static` would then serve the frontend only.
