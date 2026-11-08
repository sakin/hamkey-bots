# Cards are records, and approvals happen outside tool calls

A Bot asks for a Card through a tool (`suggest_sharing`, `ask_choice`). The tool validates the request against a fixed catalog, stores a waiting Card in `<dataDir>/cards.json`, and returns at once. The Member's tap arrives later as `POST /api/cards/:id/actions`, which the server checks (the Card exists, the Member is an addressee, it is still waiting, the action fits its type) and applies itself. A Choice tap is then delivered to the conversation as a `hamkey.card-action` entry through the documented `entry` input, so the Bot hears it as a new input.

Nothing waits inside a tool call, so `beforeTool` is not used to hold for an answer and nothing needs to survive a restart mid-call: the Card is a record on disk, and a restart loses nothing. A Bot has no tool that approves, so text such as "I approve" or another `memory_save` cannot share a Fact; only a tap by the addressee can. An ignored or rejected Card leaves the Fact private forever.

Cards live in a Hamkey file store, not in Pi documents, because they are addressed to Members across threads and badges and push need "what waits for Member M", which a conversation's own documents cannot answer. Cards in a thread are matched by thread id, and each Member sees only Cards addressed to them.

A Fact is shared by setting a Topic on it in the Memory module (`setTopic`, called only by the server). Asks later read `listShared(scope, topic)`. Only a Member's personal Facts can be shared; household Facts are already shared with both Members.

`test/restart-recovery.test.ts` checks this against a real kill: a Card posted by a Bot is still waiting after the server is killed with SIGKILL, and a tap on it afterwards still shares the Fact or reaches the Bot.
