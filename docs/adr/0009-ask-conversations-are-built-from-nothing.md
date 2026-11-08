# Ask conversations are built from nothing, behind an inert binding

ADR 0003 says an Ask runs in a restricted turn. This records how that is made unavoidable. A task-owned conversation copies its owner's agent, and a child really did run the asker's tool that way. So every Ask conversation is created by one function, `askConversation()`, whose signature takes no tools, extensions or instructions: it sets no tools, no extensions (so no memory, notes or capabilities section either), instructions the server writes, and the Member's approved facts for the Topic. There is no argument through which the asker's agent could be passed.

Its binding names `ask:<member>`. The colon cannot appear in a real Bot id, so every Bot-and-Member lookup inside it finds no access. If a tool ever reached it, the tool's own binding check refuses; this is a second lock, not the main one.

The server also decides, before any model runs, that the Topic is real, the Member exists and is not the asker's own, and the Member's Exposure List (read from its file on every Ask) names the asking Bot. If nothing was approved under the Topic, it answers "nothing shared" without a model, since there is nothing to answer from.

Two choices follow from the same aim. The `ask` tool is ticked per Bot, not on by default, like `research`: it reaches beyond the Bot's thread and costs a model run, and nothing is exposed until the Member lists the Bot anyway. And only Household and Common Bots can be listed on an Exposure List, so one Member's screen never shows the name of a Bot the other keeps private. Letting another Member's Personal Bots Ask would need a way to list them without that leak.
