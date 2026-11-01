# All conversations share one store

All Pi Durable conversations live in one SQLite store, while memory stays separate per scope. This replaces the spec's proposal of one SQLite file per scope, which would have meant building our own task layer for Asks and research across stores, for little protection: ADR 0002 already limits what Bots can reach, and the Operator can read either arrangement.

The cost is that a bug could show a Member the wrong thread, so the server checks ownership on every thread read, and those checks have dedicated tests.
