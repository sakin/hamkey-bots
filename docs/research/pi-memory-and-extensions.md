# Pi memory options and related projects

Checked 2026-10-31 from npm and package READMEs. Nothing was installed or run, so all compatibility notes come from reading packages.

## Scale

npm search returned 13,094 packages for the `pi-package` keyword, and dozens of them are memory packages. Most target `@earendil-works/pi-coding-agent`, not `@earendil-works/pi-durable`. Those depend on the coding agent's extension API, so they need porting.

## Memory packages

| Package | Runs on Pi Durable? | Notes |
| --- | --- | --- |
| `pi-durable-memory` 0.2.0 | Yes, on Cloudflare | Scoped memory with `memory_note`, `memory_recall` and `memory_zoom`, based on OptMem. It has no public Node entry point, and cannot remove a single memory, only a whole scope. |
| `@sigrun/memory-markdown` 0.1.2 | Through Sigrun | Simple markdown memory behind Sigrun's `MemoryBackend` extension contract. |
| `@sigrun/memory-honcho` 0.1.1 | Through Sigrun | Uses Honcho as a memory service. |
| `pi-hermes-memory` 0.9.11 | No | Memory, FTS5 session search and secret scanning. Has 22 imports from the coding agent package, so it would need porting. |

Single-memory removal matters for Hamkey because the Remembered Card has a forget action (U31).

## Related projects

- **Sigrun** (`@sigrun/sigrun` 0.4.1): a multi-user personal assistant server on Pi Durable, with a web UI, per-user execution jails, household conversation sharing, forward-auth login, jobs, and replaceable memory backends. First release 2026-10-22, 13 releases by 2026-10-31. Its contracts can still change between minor releases.
- **Pi Pocket** (`pi-pocket` 0.27.0): a mobile-first multiplayer web app for the Pi coding agent, with push notifications and a home-screen app. Coding-focused, but useful as a reference for PWA and push.

## Sources

- https://www.npmjs.com/package/pi-durable-memory
- https://www.npmjs.com/package/@sigrun/sigrun
- https://www.npmjs.com/package/pi-pocket
- https://pi.dev/packages/pi-hermes-memory
