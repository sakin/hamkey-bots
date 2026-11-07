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

**Seeded Bot**:
A Bot that Hamkey ships as a starting point, such as the meal planner. Seeded describes where a Bot came from; it gives the Bot no special status over Bots the Members create.
_Avoid_: Default bot, built-in bot

**Common Bot**:
A Bot with one definition and a separate private thread for each Member.
_Avoid_: Shared bot, global bot

**Research Bot**:
The Seeded Common Bot that does web research for Members and for other Bots. It is the only Bot with web access.
_Avoid_: Web bot, search bot

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
