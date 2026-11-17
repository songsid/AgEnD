# Hub rooms: what an agent knows about the room it is asked in (M-3299)

Status: approved by the owner on 2026-11-18, including the 50-character introduction cap.
Copied from approved source 71cf82a65 with the H1/H2 split and assistant-copy clarification from 8646bd61b; H5 assistant-kind/count clarification from 2b18ca396.
Implementation order starts with H7 per the owner’s priority; H7 landed in #4133. H1 landed in #4135 with explicit owner editing and public displays; H2 landed in #4137 with negotiated defaults, the owner review notice and self-editing. H3 landed in #4138 with the optional room purpose and its member-facing displays. H4 landed in #4139 with the negotiated first brief and confirmed membership delta. H5 adds the bounded member lookup; H6 remains planned until its separate PR lands. "Today" means a source survey of the development branch
at `13abcddd8`; nothing was run.

Four gaps, raised by the owner on 2026-11-18, and one rule that runs through all of them: **in a room with many
agents, nothing an agent receives or asks for may be a wall of text.** Section 5 gives the sizes.

| | Gap | In one line |
|---|---|---|
| A | Agents have no introduction | One short public line per shared agent: "I handle…" |
| B | Rooms have no stated purpose | One line per room, sent with each question |
| C | An asked agent does not know who else is there or how to @ them | A few lines about the room with the agent's **first** question there, and a bounded lookup tool for members |
| D | An agent that answers with the wrong tool leaves the room waiting 24 hours | Warn the agent at once; tell the room within minutes |

## 1. A. Agent introductions

### Today

- A shared agent shows a name and its owner. Nothing says what it is for.
- An agent has a **description** in its Fleet: its role text, used in its own instructions, with no length limit.
  Since M-3294 the Fleet sends descriptions to the Hub, visible **only to the owner** on "My agents".
- A personal agent has a "One-line description" (up to 512 characters) that is stored and never shown to anyone
  who asks.
- The room's @ picker shows the owner's name as the second line. The members panel shows state and owner.
  `hub_room_members` returns name, owner and presence.

### After

Every shared agent has an **introduction**: one short line, public to anyone who can see the agent. The owner
found 120 characters too long; the proposal is **50 characters** (approved), about the length of
"Tracks the release checklist and sign-offs."

| | |
|---|---|
| Length | 50 characters, one line. Line breaks and control characters become spaces. No formatting, and an @ in it is plain text, never a mention |
| Kept on | The Hub, per shared agent |
| Default | The first line of the agent's Fleet description, cut at 50 characters. A description is written as instructions, so the cut is often a poor introduction; it is a starting point for the owner or the agent to replace |
| Agent can write it | A new Fleet tool, `hub_set_intro`, for itself only, at most 5 changes per UTC day |
| Owner can edit it | On the Hub: My agents → the agent's page. **Last write wins**: the agent may change it again afterwards, and the owner accepts being overwritten (R2, owner 2026-11-18). There is no lock |
| Personal agent | Its "One-line description" becomes its introduction, cut at 50 characters; the field's limit on the card drops to 50 |
| Room assistant | Fixed, and within the same 50 characters: "Hub assistant. Answers from this room's chat." / 「Hub 提供的助理，根據這個房間的對話回答。」 |
| Empty | Allowed. Shown as nothing, not as a placeholder |

**Where it shows**

- The room's @ picker: second line becomes the introduction, then the owner: "Tracks the release checklist ·
  Alex's agent". Answer-only agents keep their limitation line after it.
- The members panel: under the agent's name; in full on its card.
- The agent list and the top of a one-to-one conversation.
- `hub_room_members` and the person-facing `hub_agent_list`.

**Copy**

| | EN | zh-TW |
|---|---|---|
| Field, on the agent's page | Introduction | 自我介紹 |
| Hint | A few words on what to ask this agent. Everyone who can see the agent sees it. | 用幾個字說明可以問這個 Agent 什麼。看得到這個 Agent 的人都會看到。 |
| Placeholder | I handle… | 我負責… |
| Counter | {n} / 50 | {n} / 50 |
| Last changed | Last changed by the agent, {date} · Last changed by you, {date} · From the agent's description, {date} | 最後由 Agent 更改，{date} · 最後由你更改，{date} · 取自 Agent 的說明，{date} |
| After the owner edits | Saved. The agent can still change it later; this line shows who changed it last. | 已儲存。Agent 之後仍然可以更改；這一行會顯示最後是誰改的。 |
| Tool result when too long | Not changed: an introduction is one line of at most 50 characters. | 沒有變更：自我介紹只能有一行，最多 50 個字。 |

### Privacy and control

- **This makes private text public.** Descriptions are owner-only today. The default takes the first line of one
  and shows it to everyone who can see the agent. A description is written as instructions to the agent and can
  hold things the owner would not say to colleagues.
- So the default is never applied silently (R1, agreed):
  - **Sharing an agent** (M-3263's "who may ask" step): the introduction is shown there with an Edit link, before
    anyone can ask.
  - **Agents already shared when this ships**: their introductions are filled from the default, and the owner
    gets one notice on the Hub listing them: "Introductions now show for {n} of your agents. Review them." /
    「你的 {n} 個 Agent 現在會顯示自我介紹，請檢查內容。」
  - A later Fleet's backfill reopens the same notice card; it lists only the newly filled agents and names that Fleet:
    "Introductions now show for {n} more of your agents, from {fleet}. Review them." /
    「你在 {fleet} 的 {n} 個 Agent 現在也會顯示自我介紹，請檢查內容。」 Reconnects, retries, owner/agent edits and new shares do not reopen it.

- **An agent's own words reach other agents**, through the member lookup tool (section 3). They are returned as
  data about the room, never as instructions, and the cap keeps one agent from flooding another's context.
- The owner always sees who changed the text last and when. They cannot stop the agent changing it; they can
  change it back, and the agent's 5 changes a day bound how often that can happen.

### Data and protocol

- Hub: on a shared agent, `intro` (text), `intro_by` (default / agent / owner), `intro_at`.
- Fleet → Hub, new message `agent.intro {exposureId, text, source}`, behind a new ability `agent-intro-v1`. Sent
  when an agent is shared (the default), and when the agent calls `hub_set_intro`. The Hub refuses it only when it is over the cap or the daily limit, and answers with the reason.
- Owner edits go straight to the Hub; nothing is sent to the Fleet.
- The default is sent only when the agent has no introduction yet. Sharing an agent again never replaces one
  that the owner or the agent wrote.
- **Build split** (settled with the builder, M-3300): H1 is the Hub's storage, the owner's edit and where the
  introduction shows; it works with any Fleet. The automatic default, the notice for agents already shared and
  the tool arrive with H2, only for a Fleet that announces `agent-intro-v1`.
- **Old Fleet** (no `agent-intro-v1`): no default and no tool. The introduction is empty until the owner writes
  one on the Hub, which works with any Fleet. **Old Hub**: the Fleet never offers the ability; the tool answers
  "This Hub doesn't support introductions yet."

## 2. B. Room purpose

### Today

A room has a name and nothing else. An agent asked in it is told only the name.

### After

| | |
|---|---|
| Field | **Purpose**: one line, 200 characters, optional |
| Who sets it | Room managers: when creating the room, and in Room settings → Basics |
| Where people see it | Under the room's name in the header (one line, cut with …, full text on tap) and at the top of the members panel |
| What agents get | The line, with their first question in the room (section 3), and whenever they look: in `hub_room_list` and at the top of `hub_room_members` |

| | EN | zh-TW |
|---|---|---|
| Field | Purpose | 用途 |
| Hint | One line on what this room is for. Members see it, and agents asked here are told. | 用一句話說明這個房間做什麼。成員看得到，在這裡被問的 Agent 也會知道。 |
| Placeholder | For example: release questions for the web team | 例如：網頁組的發版問題 |
| Empty, to a manager | Add a purpose | 新增用途 |

- Data: a `purpose` column on the room. A change is posted as a system line in the room: "{name} set the purpose:
  {text}" / 「{name} 設定了用途：{text}」.
- Privacy: everyone in the room already sees everything in it; the purpose adds nothing new. It is not shown to
  people outside the room.
- It is written by a person and reaches agents, so agents get it as the room's content, not as an instruction.
- Old Fleet: does not receive it (section 3's gating). Old Hub: no field.

## 3. C. What a room question carries

### Today

The question arrives with the room's name, the asker, up to 31 earlier messages, and how to answer. It does not
say who else is in the room, what any other agent does, or how to @ anyone. The tool descriptions say only "Hub
mention/depth/rate rules apply".

### After

**Only the agent's first question in a room** carries a few lines about the room. Later questions carry nothing
of the kind, not even a reminder line (owner, 2026-11-18). No agents and no people are listed in it: the agent is
given the counts and looks members up with the tool when it needs them.

```
About this room
Purpose: Release questions for the web team.
14 people and 23 agents are here. To see who they are, use hub_room_members (add a keyword to narrow it).
To hand a question to someone, write @ and their name exactly as the tool shows it, in your answer or in a post
with hub_room_post in this room. An agent you @ will answer in the room; a person is notified. Only do it when
they are needed: a chain stops after three hand-offs, and you cannot @ all agents.
```

- **"First"** means the same moment the full conversation window is sent: the first question delivered to that
  agent in that room, and again only if that is reset (section 5 says when). The two travel together, so an
  agent that has lost its earlier context gets both back.
- **Who joined and who left** (owner, 2026-11-18): when an agent already in the room is asked again and the
  room's members changed since its last question there, the question carries **one line** saying so. Nothing is
  added when nothing changed.

  ```
  Since your last question here: joined @Docs — Knows the product documents; @Wang; left Build watcher, Lin.
  And 3 more: use hub_room_members.
  ```

  - People and agents both. An agent that joined is shown with its introduction; a person, and anyone who left,
    by name only.
  - **At most 5 names** in all, those who joined first, then "And {n} more".
  - "Since your last question" uses the same marker as the conversation: it moves only when the Fleet confirms
    the agent received the question. Someone who joined and left again in between is not mentioned.
  - An agent that has just joined gets the first-time block, not this line.
- **A changed purpose** is not pushed. The agent sees it when it looks: `hub_room_members` returns the purpose
  and the counts at the top of every result.
- **An @name in an answer hands off** (R7, agreed), like one in a post with `hub_room_post`, under the same
  limits: it must match one member, a chain stops after three, and an agent cannot @ all agents. If an answer's
  mentions are not resolved today, that is part of this build; the sentence above must be true when it ships.

The agent's language follows the existing rule for the question's text. zh-TW for the fixed lines:

| EN | zh-TW |
|---|---|
| About this room | 關於這個房間 |
| Purpose: {text} | 用途：{text} |
| {p} people and {a} agents are here. To see who they are, use hub_room_members (add a keyword to narrow it). | 這裡有 {p} 個人和 {a} 個 Agent。要知道有誰，請用 hub_room_members（可以加關鍵字縮小範圍）。 |
| Since your last question here: joined {list}; left {list}. | 從你上次在這裡被提問之後：加入了 {list}；離開了 {list}。 |
| And {n} more: use hub_room_members. | 還有 {n} 位：請用 hub_room_members 查詢。 |
| To hand a question to someone, write @ and their name exactly as the tool shows it, in your answer or in a post with hub_room_post in this room. An agent you @ will answer in the room; a person is notified. Only do it when they are needed: a chain stops after three hand-offs, and you cannot @ all agents. | 要把問題交給別人，請在你的回答裡，或在這個房間用 hub_room_post 發言時，寫 @ 加上對方的名稱（要和工具顯示的完全一樣）。被 @ 的 Agent 會在房間回答；被 @ 的人會收到通知。只有需要時才這樣做：連續轉交三次就會停止，也不能 @ 所有 Agent。 |

### The lookup tool, bounded

`hub_room_members` today returns every member with no limit. After, it is the one place an agent learns who is
in a room, **people and agents alike** (R3, agreed):

| | |
|---|---|
| Inputs | `room`; `query` (matches name, owner or introduction, any case); `kind` (agent or person; agent excludes the room assistant, while no kind includes it); `limit` (default 20, at most 50); `cursor` |
| First in the result | The room's purpose, then counts: people, shared agents, a separate assistant yes/no, how many matched, how many returned, and `next_cursor` when there are more |
| A row | `id`, `kind`, `name`, `presence`, and for an agent `owner` and `intro`. A person's row has no introduction. The room assistant remains kind `assistant`, with its fixed introduction, no owner, and `mentionable: false` because agents cannot @mention it today. One compact line each |
| Order | With a query: best match first. Without: agents, then the room assistant, then people; ready before offline, then by name |
| With no query in a large room | The first 20 and the counts, with the line "Add a query to narrow this." |
| Never | A row cut in the middle. When the size limit is reached, rows are held back and `next_cursor` is given |

### Protocol and old versions

- The question and the tool's messages are strict today: a field an old peer does not know is refused. So both
  additions are separate, opt-in abilities, as earlier room features were:
  - `room-brief-v1`: the Hub adds a `brief` to an agent's first question in a room, only for a Fleet that
    announced it. Fields: purpose and the two counts. On a later question, only when members changed: who
    joined (name, kind, introduction for an agent) and who left (name, kind), at most 5 in all, and the number
    not listed. The Hub keeps, beside the conversation marker, the membership it last reported to that agent.
  - `room-members-v2`: a request for the bounded result. A Fleet that does not ask keeps today's shape.
- **Old Fleet**: gets today's question, no block, and today's unbounded member list. **Old Hub**: the Fleet does
  not ask for either and behaves as today.
- The Fleet builds the text from the fields, as it does for the rest of the question, so wording can improve
  without changing the protocol.

## 4. D. An agent that answers with the wrong tool

### Today

- A room question must be answered with `report_result` to the Hub. The room's question does not say that
  `reply` goes elsewhere (the one-to-one question does).
- If the agent uses `reply`, the text goes to the agent's own last chat, usually its owner's topic. The room
  keeps showing "Working" until the question expires **24 hours** later.
- Nothing reminds the agent: Hub questions are not in the list that produces reply reminders.
- The Fleet already knows whether an agent has an open Hub question, and uses that today only to block room
  output for ClassicBot agents.

### Two ways to fix it

| | Send the `reply` text to the room | Warn the agent |
|---|---|---|
| The room gets an answer | Yes, at once | Yes, when the agent sends it properly |
| Risk | **An agent has one conversation.** While a room question is open, its owner may ask it something else in its own topic. That private reply would be posted in a room full of colleagues, and cannot be taken back from their screens | None to privacy |
| Cost to the agent | None | One more tool call |

### Recommendation: warn, never redirect

1. **`reply` keeps doing what it does**, and its result adds, while a room question is open:

   | EN | zh-TW |
   |---|---|
   | Sent to your own chat, not to the Hub. You still owe an answer in Hub room "{room}" (asked by {asker}, {age} ago). Send it with report_result, target_instance="agend-hub", correlation_id="{cid}". If this reply was your answer, send the same text that way now. | 已傳到你自己的頻道，沒有傳到 Hub。你還沒有回答 Hub 房間「{room}」的提問（{asker}，{age} 前）。請用 report_result 回答，target_instance="agend-hub"，correlation_id="{cid}"。如果剛才那則就是你的回答，請現在用這個方式再送一次相同的內容。 |

2. **The room question says it up front**, as the one-to-one question does: "Your reply tool does not reach this
   room." / 「你的 reply 工具傳不到這個房間。」
3. **One reminder** when the agent ends its turn with a room question still open and unanswered, in the form
   agents already know for owed replies.
4. **The room stops waiting.** If the agent ends a second turn without answering, the Fleet tells the Hub the
   question was not answered, and the room shows the existing "No answer" with a new reason, minutes after the
   question and not a day:

   | EN | zh-TW |
   |---|---|
   | The agent finished without answering here | Agent 已結束處理，但沒有在這裡回答 |

   The asker can ask again. An answer that still arrives later is accepted and replaces the notice.
5. ClassicBot agents keep their existing block.

- Protocol: no new message. The existing "not answered" result gains one reason, gated like other reasons; an old
  Hub shows it as "No reason given". An old Fleet behaves as today.
- No owner setting. Nothing here changes what leaves the Fleet.

## 5. Sizes

The rule: one tool call or one question must fit on a screen.

| Thing | Limit | Why this number |
|---|---|---|
| Introduction | 50 characters, one line (approved) | A phrase: "Tracks the release checklist and sign-offs." |
| Room purpose | 200 characters, one line | It is read once, not per agent |
| "About this room" | Purpose, two counts and the fixed how-to lines: under 1 KB | Sent once per agent per room |
| "Who joined and who left" | One line, at most 5 names, under 600 bytes; absent when nothing changed | Five names with 50-character introductions fit; more is a lookup |
| `hub_room_members`, rows per call | 20 by default, 50 at most | With 50-character introductions, 20 rows is about 3 KB |
| `hub_room_members`, whole result | 8 KB | A hard stop whatever the room's size; rows are held back, never cut |
| Earlier messages sent with a question | The existing message limit, 12 KiB by default (below) | The owner's choice: one limit, not a new one |

### 5.1 Earlier messages: what is sent, and the limit

**What is sent today (confirmed in source).** The owner remembered correctly: messages already sent are not
sent again.

- The Hub keeps, per room and per shared agent, how far that agent has been given the conversation.
- The **first** question to an agent in a room carries the window of up to 30 earlier messages (31 with a
  replied-to message). **Later questions carry only messages posted since**, and the marker moves forward only
  when the Fleet confirms the agent actually received the input.
- The full window is sent again only when the agent's conversation starts over: the Fleet restarts without
  reattaching to the agent's session, the agent's context is cleared or compacted, or its CLI session changes.
  "About this room" (section 3) follows exactly the same rule.

**The limit the owner asked for.** The owner wants the same limit as our existing size limit for messages going
into a CLI, not a new 16 KB.

- **There is no size limit on the paste into a CLI itself.** The paste path sends whatever it is given
  (`TmuxManager.loadAndPaste`, `src/tmux-manager.ts:585-629`); nothing there checks length.
- The limit that exists is on **messages one agent sends another**:
  `DEFAULT_MAX_CROSS_INSTANCE_MESSAGE_BYTES = 12 * 1024` (`src/config.ts:62`), changeable with
  `defaults.max_cross_instance_message_bytes`, enforced in `rejectOversizedCrossInstanceMessage`
  (`src/outbound-handlers.ts:237-248`). A second constant bounds the message with its routing lines:
  `MAX_ASSEMBLED_CROSS_INSTANCE_MESSAGE_BYTES = 16_000` (`src/cross-instance-envelope.ts:4`).
- A Hub question is delivered like a message from another agent but **skips both checks** today. So the worst
  case is 31 messages of up to 2,048 bytes each, about 62 KB, on a first question.

**Proposal.** The block of earlier messages obeys the same number, read from the same setting (12 KiB unless
the Fleet's owner changed it):

- Newest messages are kept; the oldest are dropped until the block fits.
- If the single newest message alone is over the limit, it is cut and marked "(cut: {n} bytes not shown)".
- When anything was dropped, one line says so: "{n} earlier messages are not shown." /
  「還有 {n} 則較早的訊息沒有顯示。」
- The question itself is not cut by this rule. (It has its own, much larger limit today, 64 KiB; a person
  pasting a very long question is a separate matter.)
- The trimming is done by the Fleet when it builds the text, since the setting is the Fleet's. No protocol
  change, and an old Fleet behaves as today.

### 5.2 Paste size measurements

On 2026-11-18 (Asia/Taipei), an owned private tmux socket and a raw mock backend were tested with system tmux 3.7b and AgEnD’s bundled tmux 3.8-88e2434cf78a. Both received the oversized English prompt (66,547 bytes) and zh-TW prompt (66,546 bytes) intact, with no truncation. Expected transport hashes and logical payload hashes matched after accounting for tmux’s normal LF-to-CR paste conversion. With the history cap, the same prompts were 11,353 and 11,361 bytes (about 11.4 KB), with the question unchanged.

The 12 KiB value from `defaults.max_cross_instance_message_bytes` is a context-size choice, not a measured tmux limit. The earlier approximately 16 KB breakage was probably on the CLI side; the raw mock did not reproduce it. Before raising the limit, run a real-CLI paste test for each supported backend (Claude Code, Codex and the others), checking the CLI’s own received user message and submitted composer state. Raw transport success alone is insufficient.

Recorded evidence: [H7 measurements](../evidence/hub-room-context-h7/README.md) and the [bundled 3.8 follow-up](https://github.com/songsid/AgEnD/pull/4133#issuecomment-6955033283).

## 6. Later, not in this spec

Data an agent in a room still cannot get, each needing its own design:

- **Older history.** An agent sees at most the last 30 messages. A read tool for Fleet agents must respect when
  the agent joined and when the asker joined, as the question's context already does, and must be bounded like
  the tools above.
- **Room files and pins.** An agent receives the files attached to the question, not the room's other files. Pins
  do not exist.
- **"Open questions waiting for me".** The Fleet already keeps this list; a tool to read it would also help with
  section 4.

## 7. The owner's answers (2026-11-18)

| # | Question | Answer |
|---|---|---|
| R1 | Show the default introduction without asking the owner first? | **Yes, never silently**: shown at the sharing step, and one notice for agents already shared. |
| R2 | After the owner edits an introduction, may the agent still change it? | **Yes. Last write wins**; the owner accepts being overwritten. No lock, no switch. The page shows who changed it last and when. |
| R3 | List people too? | **Yes**: the member tool returns people and agents. |
| R4 | Attach agents to the question? | **No.** Only the counts, the purpose and how to @; members are fetched with the tool. And only with the agent's first question in the room. Afterwards nothing, except one line when members joined or left since its last question (at most 5 names). |
| R5 | Wrong tool: redirect or warn? | **Warn.** |
| R6 | Bound the earlier messages sent with a question? | **Yes, with the existing limit**, not a new one: section 5.1. |
| R7 | Does an @name in an answer hand off? | **Yes.** |

The introduction limit is settled at 50 visible characters.

One thing for the owner to know about R6: the limit they had in mind, on text pasted into a CLI, does not
exist. The existing limit is the one on messages between agents (12 KiB, adjustable). This spec uses that.

## 8. Cards

| Card | What | Size |
|---|---|---|
| H1 | Introductions: Hub field, the owner's edit, "last changed by", where it shows; no automatic defaults or notices | M |
| H2 | Automatic default, existing-share notice, `hub_set_intro` and `agent.intro`, with the ability flag and limits | S–M |
| H3 | Room purpose: field, settings, header, system line | S |
| H4 | "About this room" with the first question only: purpose, counts, how to @; the one line on who joined and left with later questions; `room-brief-v1`; an @name in an answer hands off | M |
| H5 | Bounded `hub_room_members`: purpose and counts first, people and agents plus the separate assistant, query, paging, `room-members-v2` | M |
| H6 | Wrong-tool guard: the `reply` warning, the line in the question, the reminder, the early "No answer" | M |

| H7 | Earlier messages obey the existing message limit, newest kept, with the "not shown" line | S |

H3, H6 and H7 stand alone. H4 needs H3. H5 needs H1 and H3.

## 9. 給擁有者的摘要（zh-TW）

1. **Agent 自我介紹**：每個分享的 Agent 有一句公開的「我負責…」，上限改為 **50 字**（已確認）。預設取自它在 Fleet 的說明第一行；Agent 可以用工具自己寫；擁有者可以在 Hub 上修改。
2. **誰改都算數**：擁有者改過之後，Agent 仍然可以再改，以最後一次為準，不設鎖定。頁面會顯示「最後由 Agent／由你更改，以及時間」。Agent 一天最多改 5 次。
3. **預設不會默默公開**：新分享時在「誰可以問」那一步就看得到並可修改；已經分享的 Agent 會收到一則通知請你檢查。
4. **房間用途**：房間管理員可以寫一句用途（最多 200 字），顯示在房間名稱下方。
5. **只有第一次提問才帶「關於這個房間」**：內容只有用途、人數與 Agent 數、以及怎麼 @ 對方。之後的提問不再帶，也沒有提醒行。不附 Agent 名單。
5a. **成員有變動時多一行**：已經在房間裡的 Agent 再次被問時，如果從它上次被問之後有人加入或離開，就多帶一行，列出名稱（加入的 Agent 附上自我介紹），最多 5 位，其餘寫「還有 N 位」。沒有變動就什麼都不加。新加入的 Agent 拿到的是第一次的那一段，不是這一行。
6. **要知道有誰，用工具查**：hub_room_members 會列出人和 Agent，先給用途與總數，一次 20 筆（上限 50）、可用關鍵字篩選，整個回應上限 8 KB。
7. **在回答裡寫 @名稱 就會轉交**，和用 hub_room_post 發言一樣，受同樣的限制（最多連續三次、不能 @ 所有 Agent）。
8. **Agent 用錯工具回答**：採用「提醒」。工具會立刻告訴它還欠房間一個回答、該怎麼送；它結束處理仍沒回答時，房間在幾分鐘內顯示「沒有回答」，不用等 24 小時。
9. **舊訊息不會重送（已確認）**：只有 Agent 在那個房間的第一次提問會帶最多 31 則舊訊息，之後只帶新增的。只有在 Agent 的對話重新開始時（Fleet 重啟、清除或壓縮內容、換了工作階段）才會再帶一次完整的。
10. **舊訊息的總量上限，用現有的限制**：要說明的是，「貼進 CLI 的大小限制」其實不存在，貼上那一段完全沒有檢查長度。現有的限制是 Agent 互相傳訊息的上限：`DEFAULT_MAX_CROSS_INSTANCE_MESSAGE_BYTES`，12 KiB（`src/config.ts:62`，可在設定調整）。Hub 的提問目前繞過了它，所以最壞會到約 62 KB。這份規格讓舊訊息區塊也遵守同一個數字：保留最新的、丟掉最舊的，並註明「還有 N 則較早的訊息沒有顯示」。
