# Pi Durable is the agent runtime

Hamkey runs on Pi Durable (`@earendil-works/pi-durable`) on Node, rather than a ready-made platform such as Hermes, because Hamkey's scopes, gatekeeper, Cards and approvals are custom and need a runtime we can build around. Pi Durable is experimental and its API changes without notice, so we pin an exact version and keep it behind a thin interface of our own. Hermes was not evaluated in depth.

We build our own app rather than extending Sigrun, a multi-user assistant server on Pi Durable, because it is very new and does not model Hamkey's privacy rules. Sigrun is MIT licensed, so we may reuse parts of it, kept isolated and with its licence notice retained.

SQLite migrations can block rollback across a Pi Durable release, so every upgrade needs a backup taken first.
