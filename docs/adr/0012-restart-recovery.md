# A killed server resumes its work, and a tool is replayed only if a rerun repeats no side effect

On start the engine calls Pi Durable's `harness.resume()`, so a conversation, a tool call or a research or Ask child that a dead process left unfinished continues from its last checkpoint, with no request needed to wake it.

A tool declares `replay: "safe"` only when running it twice cannot repeat a side effect. Any other tool is not run again: the model is told the call "was interrupted and may have partially run". Decisions:

- Safe: `memory_search` (reads), `memory_forget` (same id, same end state), `learned_update` (writes the same whole notes), `web_search` and `web_open` (read only; the remembered links ignore duplicates), `suggest_sharing` and `ask_choice` (the Card id comes from the call, so a rerun finds the same Card), `research` and `ask` (the child conversation is owned by the call and found again; the Ask log keeps one entry per call id).
- Not safe: `memory_save`. Each run adds a Fact with a new id, so a rerun would save it twice. After a crash the model can check with `memory_search`.

Pi Durable parks a task cut off by `settings.restartLimit` crashes in a row. The engine lists a thread's parked tasks (including those inside its research and Ask children) and the thread view then says `stuck`. The Member sees "This conversation stopped after repeated crashes" with a Retry button, which calls `POST /api/bots/:bot/retry` behind the same ownership check as messages and runs `harness.retryTask()` on those tasks.

A message resent after a dropped connection carries the same request id, which the server prefixes with the Member id, and Pi Durable returns the existing submission instead of a second one, also across a restart.
