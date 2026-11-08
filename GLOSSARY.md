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
A Bot that Hamkey ships as a starting point, such as the meal planner. Seeded describes where a Bot came from; it gives the Bot no special status over Bots the Members create.
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

### Memory

**Fact**:
One thing a Bot has been told to remember, kept outside any thread so it outlives compaction.
_Avoid_: Note, entry

**Memory scope**:
Where a Fact lives: the household, one Member, or one Bot (for a Common Bot, one Bot for one Member). A Bot's reach is set by its kind, never by what the model asks for.
_Avoid_: Namespace, bucket

**Learned notes**:
A Bot's own `learned.md`, which it rewrites freely to improve its habits. It is the only part of a Bot that the Bot itself changes.
_Avoid_: Self-edit, prompt

### Privacy

**Ask**:
A live request from one Bot to a Primary Bot for information about that Bot's Member.
_Avoid_: Query, bot chat, cross-bot request

**Topic**:
A named category of a Member's information, such as evening availability.
_Avoid_: Subject, tag

**Exposure List**:
A Member's own record of which Topics may be shared, with which Bots, and in how much detail.
_Avoid_: Rules file, permissions

### Running Hamkey

**Daily limit**:
The most the household may spend on models in one day, set by the Operator. Once it is reached, Bots answer nothing more until the next day.
_Avoid_: Budget, quota, cap
