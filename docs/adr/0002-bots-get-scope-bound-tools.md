# Bots get scope-bound tools, and the Operator is trusted

Hamkey limits a Bot's reach by building its tools already bound to the scopes it may use, so it has no way to name data outside them. `beforeTool` is a second check, not the main control, because a filter over a broad tool leaks if one rule is missed.

This protects against Bot mistakes and prompt injection, not against the Operator. The Operator can open the data on the server, so that Member's promise not to look is the only protection there, and the other Member should be told so plainly. Per-Member encryption was rejected because the server would still see plaintext while a Bot runs.
