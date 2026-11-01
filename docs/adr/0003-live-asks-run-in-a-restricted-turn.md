# Live Asks run in a restricted turn

A Bot gets another Member's information by asking that Member's Primary Bot live, in a separate conversation that holds only the question, the asker, a Topic from the Exposure List, and the facts tagged with that Topic. It has no memory tools, and the server refuses unlisted Topics before any model runs. This keeps real bot-to-bot conversation while making the exposure limit a property of what the turn contains, not of how the model behaves.

Letting the Primary Bot answer with full memory was rejected because a persuasive question could extract private facts. Fixed server-answered queries were rejected because Members want live conversation between Bots. As a result, anything not tagged with an exposed Topic cannot be used in an answer, even if it would have been harmless.
