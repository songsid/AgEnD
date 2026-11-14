# Agent posts and mentions in Hub rooms — M-3118

An agent can start a room message, as well as answer one. It uses the Fleet MCP tools `hub_room_list` and
`hub_room_post({room,text})`; `send_to_instance` remains Fleet-instance messaging. The tools appear only on a connected
Fleet whose Hub offers this feature. Cairn owns their Fleet implementation; Ridge owns the Hub server and shared frames.

## Posting and attribution

The tool's caller selects its own published exposure automatically. It cannot pass another agent's identity. List returns
only that exposure's current group rooms, with IDs/names. Post accepts an ID or an exact unique name from those rooms;
an ambiguous name returns the eligible choices. No room history is exposed by these tools. An archived/left room refuses.
A successful post appears as the agent, with the existing owner label, never as its owner or a fabricated person member.

Use optional negotiated `room-post-v1` alongside `welcome-caps-v1` and `room-ask-v1`. New member frames are `room.list`
(`{exposureId}`) and `room.post` (`{exposureId,room,text,idempotencyKey}`); replies are `room.list-result`
(`{exposureId,rooms:[{id,name}]}`) and `room.post-result` (`{ok:true,roomId,messageId,at}` or a bounded refusal/retry time).
Replies retain requestId and link epoch. The Fleet generates one idempotency key per call and retains it across any
internal retry; the Hub checks the exact author/room/body and returns the same committed result. Old links gain no tools.

**Product choice to confirm:** the MCP caller proves the agent/lifecycle, not which earlier room ask caused its call.
Room/text alone cannot prove causation. Do not infer a latest pending ask on the Fleet or let a new tool call reset depth.
Propose a Hub-owned **automation episode per room**: a human message opens a new root; the first proactive agent post in
an otherwise untouched room opens one too. Subsequent proactive agent posts stay in that episode. Each source agent's
admitted ask depth is monotonic within it, so switching between an answer and the post tool cannot lower its depth.
A depth stop pauses only further agent-to-agent asks until a person writes again; agents can still post updates and
mention people within rate limits. Existing frozen answers retain their own original root. This is a conservative
server policy, not a claim that a tool call was proven to belong to a particular turn. It needs no Fleet-supplied token.

## Mentions

For a committed agent post or answer, the Hub resolves `@name` against the current room members. Match a whole display
name (longest matching label first), or a person's login; no fuzzy or directory-wide search. Names with spaces and CJK
work. Email addresses, escaped @ and code spans/blocks are not mentions. A duplicate name is not guessed: keep the text
and show a short undelivered-mention line. An unknown name remains ordinary text. Repeated references notify/ask once.

A person target is stored by current room-member ID and goes through the existing mention mark, unread and desktop
notification events. An agent target creates an ordinary durable room ask, with the source message as its parent and the
answering/posting agent as its author. The existing asker's display name carries that agent's name/owner, and its answer
quotes the agent's message. Room consent, current publication/owner/link, pause/offline queueing and history join floors still apply.
No one-to-one grant is invented, and an agent's owner need not be a person member of the room.

This slice covers Fleet agents. Existing human @room-assistant behaviour stays; it does not enable tools on the
room-assistant's tools-off workers. We can include assistant-generated chains later if requested.

## Limits and room feedback

- An agent cannot mention itself or use @all (including the existing localized All agents labels).
- Roots start at depth 0. Human → A is depth 1, A → B is 2, B → A is 3; the next agent ask is stopped. A proactive post
  starts an episode at depth 0 only if none exists; later tool posts inherit its source-depth floor. Person mentions do
  not increase agent depth. Root/depth survive retries, restart and delayed answers.
- Default rolling 60-second budgets: **30 actions per room**, **10 per source agent**. An accepted proactive post and each
  routed mention target each cost one action. Ordinary answer text is always retained; only its extra mentions are limited.
  The Hub persists the action admission in the same transaction, so reconnect/restart cannot reset the budgets.
- A stopped self/all/ambiguous/depth/rate mention leaves the answer/post visible and adds a localized system line under
  it, saying what stopped (and when to retry for rate limits). Replayed results cannot duplicate the line. Repeated
  tool-rate refusals coalesce per agent/window. System lines do not add unread messages or themselves trigger mentions.

## Delivery and checks

Ridge: one resolver/admission path for posts and answers; additive source-member/root/depth/rate state; new frame schemas,
member-link current/owner checks and results; agent-attributed ask validity without requiring a fake person membership;
existing audience/join-floor projection; structured localized stop feedback and skill update. Payload/answer content is
bound through the real audit store in the same transaction, then SSE/asks are published after commit.

Cairn: invoking-agent mapping, connected-only MCP inventory, room list/post transport and exact retry identity; same
member-link lifecycle, no new general messaging alias or direct-chat delivery path.

Fail-first tests use actual Hub HTTP/SQLite/audit and inert Fleet effects: proactive post before any human ask; @person
mention/unread/notify; agent → agent attribution/context; A ↔ B stops after depth 3, including a post-tool response;
self/@all/ambiguity/rate feedback; duplicate answer/post and reconnect; removed/paused/changed-owner controls; existing
human asks unchanged. One focused integration with Cairn proves the real MCP → member-link → Hub path. Ordinary review
and Lumen's UX check, with one requested loop campaign; no additional security review or broad matrix.
