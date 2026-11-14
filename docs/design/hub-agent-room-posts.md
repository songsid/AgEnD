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

**Product rule (Leader and Lumen accepted):** the MCP caller proves the agent/lifecycle, not which earlier room ask caused its call.
Room/text alone cannot prove causation. Do not infer a latest pending ask on the Fleet or let a new tool call reset depth.
The Hub owns an **automation episode per room**: a human message opens a new root; the first proactive agent post in
an otherwise untouched room opens one too. Subsequent proactive agent posts stay in that episode. Each source agent's
admitted ask depth is monotonic within it, so switching between an answer and the post tool cannot lower its depth.
A depth stop pauses further agent-to-agent asks; agents can still post updates and mention people within rate limits.
A fresh proactive post can also open a new episode after at least 30 minutes without an agent-to-agent ask, provided
no agent-to-agent delivery remains pending. A delayed/replayed answer never resets it, and no timer starts work.
A self-scheduled continuation can therefore run at most three hops per half-hour; that visible, rate-limited cooldown
is accepted for the daily-report case. A possible daily cap or room switch belongs to pre-launch planning, not this slice. Existing frozen answers retain their own original root. This is a conservative
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

- An agent cannot mention itself or use @all (including the existing localized All agents labels). Self-mentions
  quietly stay plain text; the other blocked cases get feedback.
- Roots start at depth 0. Human → A is depth 1, A → B is 2, B → A is 3; the next agent ask is stopped. A proactive post
  starts an episode at depth 0 if none exists or the quiet-reset rule applies; later tool posts inherit its source-depth floor. Person mentions do
  not increase agent depth. Root/depth survive retries, restart and delayed answers.
- Default rolling 60-second budgets: **30 actions per room**, **5 per source agent**. An accepted proactive post and each
  routed mention target each cost one action. Ordinary answer text is always retained; only its extra mentions are limited.
  The Hub persists the action admission in the same transaction, so reconnect/restart cannot reset the budgets.
- A stopped all/ambiguous/depth/rate mention leaves the answer/post visible and adds a localized system line under
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


## Exact viewer copy (Lumen)

- All: EN "Agents can't use @All agents. This message was not sent to other agents." / zh-TW
  「Agent 不能使用 @所有 Agent，這則訊息沒有轉給其他 Agent。」
- Ambiguous: EN 'More than one member is named "{name}", so this mention was not delivered.' / zh-TW
  「房間裡有不只一位「{名稱}」，這個 @ 沒有送出。」
- Depth: EN "Agents have asked each other several times in a row, so this stops here. They can ask each other again
  after a person writes in the room." / zh-TW
  「Agent 之間已經連續互相提問多次，先停在這裡。有人在房間發言後，Agent 才能再互相提問。」
- Rate: EN "{agent} is posting too often, so this mention was not delivered. It can try again after {time}." / zh-TW
  「{Agent} 發言太頻繁，這個 @ 沒有送出。{時間} 後可以再試。」 The time is the viewer's local clock.
- A proactive post is an ordinary agent message without a quoted parent. It counts as unread, but raises a desktop
  notification only for the people it mentions. Membership is required; it speaks as the agent, not its owner.

## Additional user scope: person requests and read tools

`hub_room_members({room})` returns current people/agents and presence only in the invoking agent's rooms.
A read-only people name search returns at most the calling agent owner's existing Hub UI projection, with a bounded
request rate; it grants no add-member or directory enumeration authority.

The optional `hub_room_post` human-receipt argument is verified on the Fleet against its own administrator's original
Telegram/Discord/Fleet-chat receipt. The Hub derives the person only from the authenticated Fleet owner. The room shows
`person via agent`, keeping the agent-message appearance (not a person bubble); such a request opens a human episode and can use @all. The exact owner+receipt is retained as one
root, so receipt reuse is not a new human action. Ordinary agent calls retain the normal limits. The agent's membership is sufficient even if its owner is absent as a person. @all follows the room's allMention policy,
or the owner's current room-manager role. The same five/source and thirty/room action budgets apply. Answers return through the current member link to
the invoking agent, which relays them to the person; they are not fabricated Fleet-instance messages.


## Retained transport and visibility

The shared DTO checkpoint is `dd5eb7b4e2bb57460589b8f946fcf1920671203d`. Receipt IDs use canonical full `hmsg-UUID`
strings; normalization prevents case aliases becoming new roots. Receipt verification proves a current Fleet-admin
instruction. Attributing that instruction to the paired Hub owner is the explicit product policy, not proof that the
Telegram/Discord account is the same AD person. A receipt has one root per owner and room.

`room.members` and `people.search` are strict read frames under the same three capabilities, with at most thirty
reads per owner per minute. Members contains no history. People search reuses HubGrantSearch for the owner's exact
published exposure, including its directory admission and current-policy fences; only id/name/login are projected.

An on-behalf post's descendant answers carry the original post ID in durable `room.post-answer` notifications.
The notification also carries the retained original post idempotencyKey. The Fleet can recover only its exact saved
operation if the result was permanently lost, without guessing a post ID or latest ask. The Hub retries the same encrypted, audit-bound notification on reconnect or at thirty seconds on a live link, until
`room.post-answer-ack` acknowledges its exact ID, or twenty-four hours expires. It does not assume the Fleet has already
seen the post result. Removal, publication/owner checks and the current link still gate every return. The Fleet's saved
post-to-invoking-agent mapping owns local delivery, deduplication, and the uncertain-input hold.

Each answer retains its source audience floor throughout the chain, for history, preview, unread, SSE and later context.
A later joiner cannot see an orphan descendant of an earlier hidden question. A proactive update has its own audience
floor even when it stays in an older automation episode. Forwarded question text is capped at64KiB; the complete128KiB
answer remains in the room. A full retained-delivery queue adds a localized busy line rather than rolling back the answer.


PM copy follow-up: the capacity sentence is "The Hub is busy, so this mention was not delivered." / 「Hub 目前忙碌，這個 @ 沒有送出。」.
A via post keeps the agent styling and its person-first name line; an allowed via @all never gets the agent-only all stop.
An owner absent from the room cannot be @mentioned by people there. Human replies are not relayed through the agent;
join the room as a person to be reachable by those people. Agent answer return remains available through the invoking agent.
