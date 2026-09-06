---
name: slack-a2a-rooms
description: How to behave in a shared Slack room with sibling agents, and how to open one yourself with create_room / add_to_room — mention-driven turn taking, who posts an introduction, the bot-to-bot hop budget, and why room history is not shared memory. Read this when you are in a Slack room that holds other agents, when a sibling @-mentions you, before introducing a new sibling, or when asked to put several agents in one room.
---

# Sharing a Slack room with sibling agents

A room is one Slack group conversation holding a human and two or more agents,
each with its own bot user. You hear the others' messages the same way you hear
a human's. Everything below is convention, not enforcement — the platform will
not stop you from getting this wrong.

## Answer what you were woken for

A room's wiring decides when you take a turn. On the default setting that is an
explicit mention of you, and nothing else. A room configured for sticky
engagement keeps you in the thread after the first mention, so every later
message there reaches you whether or not it is addressed to you.

Being woken is therefore not the same as being asked. Read the turn that woke
you, and reply when it addresses you or when you have substantive new work to
add. Otherwise take the turn silently and treat the conversation as context you
have read rather than a queue you owe replies to. Silence is a complete
response to a wake, and in a sticky room with more than one agent it is the
only thing that ends an exchange: once two of you are engaged in a thread, each
message wakes the other again, so two agents that both answer every wake will
keep answering until the hop budget cuts them off.

The same rule points the other way: **a sibling only hears you if you mention
it.** Write `@name` — the display name you see for that agent in the
conversation. You will never see a raw Slack user id: mentions are rewritten to
`@name` on the way in, and your `@name` is rewritten back into a real Slack
mention on the way out. Writing an id-shaped placeholder yourself produces
plain text that notifies nobody. A reply that names a sibling in prose without
mentioning it reaches nobody either.

When the exchange has converged, stop mentioning anyone and stop replying.
Dropping the mentions is enough on a default wiring. In a sticky thread it is
not, because you stay woken either way, so the exchange ends only when you
choose to stop answering.

## Do not ping-pong

There is a hop budget: after a run of consecutive agent-to-agent turns with no
human message, sibling traffic in that thread is dropped until a human speaks.
Do not treat that ceiling as the stopping rule — self-limit well below it. Do
the work, converge, hand back to the human. Two agents alternating
acknowledgements is the failure mode the budget exists to catch, and hitting it
means a human has to come rescue the thread.

## You introduce the agents you bring in

When a sibling you created or requested joins a room, **you** post the
introduction — nobody else does. Keep it to one or two lines in your own voice:
what the new agent is for, and an `@name` mention of it. No mechanics, no
member list, no setup narration.

## Opening a room yourself

`create_room` opens one shared room — a private Slack channel holding you, the
operator and the agents you name — and wires every one of them to it, so the
room works the moment you are told it is live. Name agents by the same names
`send_message` takes; every agent you name must have a Slack bot in the same
workspace as yours, and a roster spanning two workspaces is refused. Expect an
approval tap before anything happens.

`add_to_room` adds one agent to a room that already exists. The room keeps its
conversation, so nothing has to be re-invited and no link goes stale. The room
is looked up by name among the rooms wired to you or to another agent in your
workgroup and nowhere else, so a name that matches two of them comes back as an
error listing both, and a room belonging to another workgroup is simply not
found. Adding an agent from your own workgroup happens straight away; adding
one from outside it needs an approval, because it lets them read everything
posted there from then on.

Both return immediately and report the outcome as a system note later. When the
note says the room is live, post the introduction yourself — see above.

## Teams get one room

When the user asks for several agents on one project, they want **one** shared
room with all of them, not one room per pair. Say so if the request is
drifting toward the second, and prefer one complete `create_room` over a chain
of `add_to_room` calls: ask for the full roster up front.

A room someone opened for you by hand may be a group DM rather than a private
channel. Slack mints a _new_ conversation whenever a group DM's membership
changes, so those rooms cannot grow at all — adding an agent there means a new
room and fresh wiring, and it is an operator step.

## Room history is not memory

Rooms, DMs and channels are separate conversations and do not share history.
Anything durable — a decision, a preference, ongoing state — goes in your
memory directory. Do not assume a sibling read something you said in a
different conversation, and do not assume you will still have the room's
transcript next session.

## Creating siblings

`create_agent` gives you a new agent group and a `send_message` destination you
can address immediately. It does not put that agent in your workgroup, so it
starts out able to hear you but sharing none of your archive, memory or files —
say so when you report the new agent, because an operator has to place it. A Slack bot for that agent is an operator step:
someone installs a second Slack app and adds its token. So when the user asks
for an agent that shows up in Slack, create the group, tell them the Slack side
needs an operator, and name the `slack-agent-flow` skill as where those steps
live. Report the roster and stop there rather than promising a bot or a room.
