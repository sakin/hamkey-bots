# Hamkey

A private hub where the two people in a household each have their own bots and share household bots.

## Language

### People

**Member**:
One of the two people who use Hamkey.
_Avoid_: User, you, partner

**Operator**:
The Member who runs and maintains the server. This is a role, not a third person.
_Avoid_: Admin, owner

### Bots

**Bot**:
A configured assistant that a Member talks to. Every Bot has the same shape, however it came to exist.
_Avoid_: Agent, assistant

**Primary Bot**:
The Bot that is a Member's front door. Each Member has exactly one.
_Avoid_: Main bot, personal assistant

**Lead Bot**:
Whichever Bot is coordinating delegated work on a request. This is a temporary role, and need not be a Primary Bot.
_Avoid_: Primary Bot, when the coordinating role is meant

**Personal Bot**:
A Bot that belongs to one Member and that only they can use. Each Member's Primary Bot is one.
_Avoid_: Private bot

**Household Bot**:
A Bot that belongs to the household rather than to one Member. Both Members use it.
_Avoid_: Shared bot

**Shared thread**:
The one thread a Household Bot has, which both Members write in. Each message shows who sent it, and the Bot sees the sender's name at the start of each message. Anything saved from it goes to household memory.
_Avoid_: Group chat

**Seeded Bot**:
A Bot that Hamkey ships as a starting point, such as the meal planner. Each is copied into a data folder once, the first time Hamkey starts there, and never overwritten; after that it is an ordinary Bot file the Members own, edit or delete, and a deleted one does not come back. Seeded describes where a Bot came from; it gives the Bot no special status over Bots the Members create.
_Avoid_: Default bot, built-in bot

**Common Bot**:
A Bot with one definition and a separate private thread for each Member.
_Avoid_: Shared bot, global bot

**Research Bot**:
The built-in Common Bot that does web research for Members and for other Bots. It is the only Bot with web access, and it has no personal memory. It opens only links from its own search results, and what it reads and says is marked untrusted. Members cannot edit it.
_Avoid_: Web bot, search bot

**Research tool**:
A tool a Member can tick on a Bot so that it can look things up. The Bot sends the Research Bot a research request and gets back text marked untrusted, without web access of its own. Each research request runs in a fresh conversation that sees only the request, never the calling Bot's thread, tools or instructions.
_Avoid_: Web tool (those belong to the Research Bot alone)

**Untrusted**:
Text from the web, and anything a Bot builds from it. It is shown to Bots wrapped and labelled, and to Members with a "from the web" note, because a page can try to give orders.
_Avoid_: Unsafe, tainted

### Cards

**Card**:
A structured prompt that a Bot posts in a thread and a Member answers with a tap. Cards come from a fixed catalog the server validates, hold plain text only, and are answered by a tap the server checks, never by anything a Bot says.
_Avoid_: Widget, form, button message

**Approval Card**:
A Card that asks a Member to share one of their own Facts under a Topic. Approving shares it; rejecting, or never answering, leaves it private.
_Avoid_: Permission request, consent prompt

**Choice Card**:
A Card that asks for one pick from two to six short options. In a Shared thread either Member may answer; in a personal thread only its Member. The pick reaches the Bot as the next input.
_Avoid_: Poll, quick reply

**Question Card**:
The Card a direct question is shown as. It holds the question as plain text and has no buttons.
_Avoid_: Prompt card

### Memory

**Fact**:
One thing a Bot has been told to remember, kept outside any thread so it outlives compaction.
_Avoid_: Note, entry

**Shared fact**:
A Fact its owner approved for sharing under a Topic. Every Fact is private when saved and becomes shared only through an Approval Card. Only a Member's own personal Facts can be shared.
_Avoid_: Public fact, approved fact

**Memory scope**:
Where a Fact lives: the household, one Member, or one Bot (for a Common Bot, one Bot for one Member). A Bot's reach is set by its kind, never by what the model asks for.
_Avoid_: Namespace, bucket

**Learned notes**:
A Bot's own `learned.md`, which it rewrites freely to improve its habits. It is the only part of a Bot that the Bot itself changes.
_Avoid_: Self-edit, prompt

### Privacy

**Ask**:
A live request from one Bot to a Primary Bot for information about that Bot's Member, made with the `ask` tool. The server refuses it before any model runs unless that Member's Exposure List lets this Bot Ask about the Topic. A Bot cannot Ask about the Member it is talking to.
_Avoid_: Query, bot chat, cross-bot request

**Ask conversation**:
The separate conversation in which a Primary Bot answers one Ask. It has no tools and no memory, and holds only the question, the asking Bot's name, the Topic and the facts the Member approved for that Topic. It never touches the Member's main thread.
_Avoid_: Ask thread, sub-chat

**Ask log**:
The record of every Ask: which Bot asked, about which Member and Topic, the question, and the answer or why there was none. Refused Asks are in it. Both Members read all of it, including Asks about the other, because every answer was shared. A Bot's name is hidden from the Member who may not use that Bot.
_Avoid_: Audit trail, history

**Direct question**:
What a Bot asks a Member in the thread when an Ask is refused, finds no approved facts or fails, instead of guessing. It is a Card with no buttons, waiting for that Member, and it is answered when they next write in the thread. It is made only if that Member can read the thread; otherwise the Bot tells its own Member it could not find out. A waiting direct question counts as a Bot needing a Member.
_Avoid_: Follow-up, fallback message

**Topic**:
A named category of a Member's information, such as evening availability.
_Avoid_: Subject, tag

**Exposure List**:
A Member's own record, for each Topic, of which Bots may Ask about it. Nothing is exposed until the Member ticks it, and a change applies to the very next Ask. Only Household and Common Bots can be listed.
_Avoid_: Rules file, permissions

### Running Hamkey

**Daily limit**:
The most the household may spend on models in one day, set by the Operator. Once it is reached, Bots answer nothing more until the next day.
_Avoid_: Budget, quota, cap
