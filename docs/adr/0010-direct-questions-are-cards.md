# Direct questions are Cards, and the Ask log is its own file

When an Ask is refused, finds no approved facts or fails, the asking Bot must not guess. The tool result says so plainly, and the server also records a **direct question**: a Card of type `question` addressed to the Member asked about, in the asking Bot's thread. It reuses the Card store (ADR 0008) rather than a separate "needs" store because `CardStore.waitingFor(member)` is already what badges and push count, so "a Bot needs a Member" has one source. The catalog validates it (one plain-text field, no buttons). The server makes it, not the Bot, from the question the Bot sent, with markup stripped and the length cut.

It is answered by the Member writing in that thread, not by a tap: `POST /api/bots/:bot/messages` settles that Member's waiting questions in that thread. The other Member writing does not. A tap on it is refused.

A direct question is made only if the Member can read the thread: a Household Bot's shared thread (or, in principle, their own). In a Common Bot's thread of the other Member the Member cannot read it, so none is made and the tool result tells the Bot to say it could not find out and not to ask the Member there. A question that waits where nobody can see it would count as a Bot needing a Member, yet nobody could act.

The Ask log is `<dataDir>/asks.json`, one entry per Ask id, never changed, so a rerun after a restart cannot log twice. Both Members read all of it. The one thing held back is the name of a Bot the reader may not use, so a Personal Bot's name does not reach the other Member; the question and outcome are still shown, since sharing is meant to be transparent.
