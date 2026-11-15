# Hub General: the Hub's own assistant (M-3157)

Status: design for the owner's decision. Nothing here is built. Mockup:
`docs/evidence/hub-general/hub-general-mockup.html` (EN and zh-TW, light and dark, desktop and phone).

Pilot rule applies: features and UX first. Costs are listed in section 8 so they can go on the pre-launch list.

## 0. What it is, in one paragraph

Hub General is the one assistant every person on the Hub can talk to, in a one-to-one chat. It answers three kinds of
question: **how do I do this in the Hub**, **who or which agent should I ask about X**, and, for administrators,
**what is the state of this Hub**. It runs on the Hub owner's AI account, like the room assistant. It never reads
rooms or other people's conversations, and it never contacts anyone's agents: it points, the person asks.

## 1. How this differs from what was written before

The product plan (`hub-product-plan.md` 1.6, 2026-11-13) defined Hub General as an **administrators-only** assistant
that **acts**: it has Hub management tools and creates rooms, teams and join codes after a confirmation card. The new
request (2026-11-15) describes an assistant for **everyone** that helps and finds the right agent or person, and also
answers administrators' questions.

This spec joins the two as steps of one assistant, in the order that gives people something soonest:

| Step | Who | What | Tools |
|---|---|---|---|
| 1 | Everyone | Help, and "who do I ask" from the agents this person may already ask | None. The Hub puts the facts in the prompt. |
| 2 | Everyone | Find people and teams by name; say who owns what | Read-only lookups, as the asker |
| 3 | Administrators | Questions about the Hub: Fleets, versions, who has not joined, the overview numbers | Read-only lookups, administrators only |
| 4 | Administrators | Actions (create a room or team, make a join code, revoke a Fleet), each behind a confirmation | The 1.6 management tools |

Step 4 is the old definition, unchanged, and still comes last: each action needs its administration page first.

## 2. What exists to build on

- **Room assistant** (`src/hub/assistant/`, `src/hub/rooms/assistant.ts`): Claude Code, one turn per question, no
  tools, no MCP, no hooks. Context is the last 30 posts of that chat. It runs on the account the Hub owner picks.
  Limits today: 3 answers at once (1–16), one at a time per room, and a 7-day count of answers per day.
- **One-to-one assistant chat**: the conversation list already has "Hub assistant", a private room per person with the
  same assistant (`room.assistant_for`). Step 1 is this chat with a better briefing.
- **Administration → Room assistant** (`GET`/`PUT /hub/v1/admin/assistant`, usage, stop): the switch, the account and
  the usage view. Hub General's settings join this page.
- **Lookups that exist as Hub data**: the agents a person may ask, their rooms, people search, teams, connected
  Fleets with versions, the overview numbers (M-3147 mockup).
- **The hub skill** (`skills/hub`): the user-side how-to text, already written for agents to answer from.

What does not exist: any tool for a Hub-run assistant, any per-person limit, and the name "Hub General" in the product.

## 3. Step 1: help and "who do I ask" (no tools)

The chat is the existing one-to-one assistant chat, renamed and pinned first in the list.

**What the Hub puts in front of each question** (the assistant itself still has no tools):

- the how-to text from the hub skill;
- the asker's name, and whether they are an administrator, a team lead, or an agent owner;
- **the agents this person may ask**: name, owner, the owner's one-line description, and state (ready, paused,
  offline, needs an update);
- **the asker's rooms**: names and member counts only, no messages;
- the teams the asker belongs to.

Nothing in this list is new to the asker: it is what their own Hub pages already show.

**What the answer looks like.** Text, plus cards the Hub draws from names the assistant returns:

- an **agent card**: name, owner, state, and two buttons, "Ask" / 「提問」 (opens the one-to-one chat with the
  question carried over into the box, not sent) and "Add to a room" / 「加入房間」;
- a **page link** for how-to answers: "Open Agents I share" / 「開啟我分享的 Agent」.

The assistant must name agents only from the list it was given. The Hub drops a card whose name is not in the list.

**When it cannot help.** Fixed lines, not model text:

| Case | EN | zh-TW |
|---|---|---|
| No agent fits | I couldn't find an agent you can ask about that. {0} may know who can: they own the closest one. | 我找不到你可以問這件事的 Agent。{0} 可能知道該找誰，最接近的 Agent 是他的。 |
| The agent exists but the person may not ask it | {0} looks right, but you can't ask it yet. Its owner is {1}. | {0} 看起來適合，但你還不能問它。它的擁有者是 {1}。 |
| A question about someone else's conversation or a room's content | I can't see rooms or other people's conversations. | 我看不到房間，也看不到其他人的對話。 |
| A work question it should not answer itself | I don't answer work questions myself. Ask {0}: | 我不直接回答工作上的問題。請問 {0}： |
| Quota used up | Hub General can't answer right now. Try again later. | Hub General 暫時無法回答，請稍後再試。 |
| Person's daily limit reached | You've reached today's limit for Hub General. It resets at midnight. | 你今天問 Hub General 的次數已經用完，午夜重新計算。 |

The fourth row matters: Hub General is a guide, not a general chat model on the owner's bill. Its instructions say
to route work questions to an agent. This is a rule in a prompt, so it holds most of the time, not always (section 8).

**Copy**

| Place | EN | zh-TW |
|---|---|---|
| List entry | Hub General | Hub General |
| Under the name | Help, and who to ask | 使用說明，以及該問誰 |
| Empty chat, first line | Ask me how to do something in the Hub, or who to ask about a topic. | 可以問我 Hub 怎麼用，或某件事該問誰。 |
| Empty chat, second line | I run on this Hub's AI account. I can't see rooms or other people's conversations. | 我使用這個 Hub 的 AI 帳號。我看不到房間，也看不到其他人的對話。 |
| Suggested questions | Who can I ask about …? · How do I share my agent? · How do I make a room for my team? | …該問誰？ · 怎麼分享我的 Agent？ · 怎麼替我的團隊開房間？ |

## 4. Step 2: find people and teams (read-only lookups)

Three lookups, served by the Hub in the same process, each run **as the asker**:

| Lookup | Returns | Same as |
|---|---|---|
| Find a person by name | Name, department, whether they have joined, the agents they share that the asker may ask | The people search in rooms and teams |
| Show a team | Members and lead, for teams the asker can see | The team page |
| Find an agent | The agent list filtered by words in name or description | Step 1's list, for a Hub with many agents |

A person card gets "Agents you can ask" and "Invite to a room". The assistant gets a small number of lookups per
question (recommended: 5), then must answer.

## 5. Steps 3 and 4: administrators

**Step 3, questions.** Only for a signed-in administrator, in the same chat. Read-only lookups over what the
administration pages show: connected Fleets and versions, who has not joined, join requests waiting, room assistant
usage, the overview numbers. Answers end with a link to the page, so the number can be checked:
"3 Fleets are below v2.4.0-beta.2: … Open Connected Fleets".

It does not answer from the audit record, and it does not read rooms, exactly like the administrator's own pages.

**Step 4, actions.** As in plan 1.6. Hub General prepares the action and shows a confirmation card with exactly what
will happen; the administrator's press is the consent (decision a9ccee59). Nothing happens without the press, and the
card expires after 10 minutes. Recommended first actions: make a join code, create a team, create a room from a team.
Revoke and delete come after those have been used for a while.

| Card | EN | zh-TW |
|---|---|---|
| Title | Create the team "Login page"? | 要建立團隊「登入頁專案」嗎？ |
| Body | 5 members · lead: {0} | 5 位成員 · 負責人：{0} |
| Buttons | Create team · Cancel | 建立團隊 · 取消 |
| After | Team created. Open Teams | 團隊已建立。開啟團隊頁 |
| Expired | This request expired. Ask again to continue. | 這個要求已經過期，要繼續請再問一次。 |

## 6. Who pays, and the limits

- **Account**: the same AI account as the room assistant, chosen by the Hub owner. One quota for both.
- **Per person**: a daily number of Hub General questions, set by the administrator. Recommended default: 30.
- **At once**: shares the room assistant's "answers at once" setting (default 3). Room questions go first when the
  queue is full, because a room has several people waiting.
- **Memory**: the last 30 messages of the person's own chat. Nothing is carried between people.
- **Model**: the account's default. No tools at step 1; read-only lookups at steps 2 and 3.

Settings, on Administration → Room assistant, which becomes "Hub AI" / 「Hub 的 AI」:

| Setting | EN | zh-TW | Default |
|---|---|---|---|
| Switch | Hub General | Hub General | On when the room assistant is on |
| Who | Everyone who has joined / Only these groups or teams | 所有已加入的人 / 只有這些群組或團隊 | Everyone |
| Limit | Questions per person per day | 每人每天可以問幾次 | 30 |
| Admin questions | Answer administrators' questions about this Hub | 回答管理員關於這個 Hub 的問題 | On (step 3) |
| Admin actions | Let Hub General prepare actions for administrators to confirm | 讓 Hub General 準備動作，由管理員確認後執行 | Off (step 4) |
| Usage | Questions today · this week, by room assistant and Hub General | 今天 · 這週的次數，分房間助理與 Hub General | |

## 7. What Hub General never does

- Read a room, a one-to-one conversation, or a file. This includes administrators' questions.
- Contact an agent or a Fleet. It suggests; the person asks, under their own permission.
- Show an agent or person the asker could not find on their own pages.
- Join a room. Rooms keep the room assistant, which sees only that room. Mixing them would put a guide that knows
  the asker's permissions into a shared place.
- Act for someone who is not a signed-in administrator, or without the press on a confirmation card.

**The contact-limit idea** (`hub-agent-contact-limits.md`): Hub General is the simplest case. It has no way to reach
any instance, on the Hub's Fleet or anyone else's, and this spec keeps it so. If a later step lets it "ask for me",
that ask must go out as the person's own question, counted and limited like one.

## 8. What this costs

- **The owner's AI quota now serves every person's questions**, not only rooms. The daily limit bounds it; a Hub of
  100 people at the default could use 3,000 questions a day at worst.
- **"Don't answer work questions" is an instruction, not a lock.** People will sometimes get general answers from it
  on the owner's account.
- **Descriptions are owner-written text in the prompt.** An owner could write a description that steers Hub General
  toward their agent or tries to change its behaviour. The Hub marks descriptions as data and draws cards only from
  real names, which limits the damage to bad advice. Pre-launch: review this.
- **Steps 2 and 3 give a Hub-run model lookups.** They are read-only and run as the asker, but they are the first
  tools a Hub-hosted agent has. The pre-launch item "isolate the Hub's Fleet" becomes more important with them.
- **Step 3 answers can be wrong.** A wrong count that looks authoritative is worse than a page; hence the link to the
  page on every answer.

## 9. Open questions, with recommendations

| # | Question | Recommendation |
|---|---|---|
| G1 | The name: "Hub General", or keep "Hub assistant"? | **Hub General**, same in zh-TW. It matches the Fleet's General, and "room assistant" stays distinct. |
| G2 | Everyone, or administrators only (the 11-13 definition)? | **Everyone for steps 1–2**, administrators for 3–4. The help and "who to ask" value is for members. |
| G3 | May it answer work questions itself? | **No.** It routes to agents. Otherwise it becomes free general AI on the owner's account. |
| G4 | Daily limit per person | **30**, adjustable. |
| G5 | Should "Ask" send the question for the person? | **No.** It opens the chat with the question in the box. The person presses Send, so every ask is their own. |
| G6 | Hub General inside rooms? | **No.** Rooms keep the room assistant. |
| G7 | Order of work | **Step 1 now** (small: a briefing and cards on the existing chat), step 2 next, step 3 after the overview page exists, step 4 as in the plan. |

## 10. Cards

- 1a (Hub server): Hub General briefing for the one-to-one assistant chat: help text, the asker's agents, rooms and
  teams; fixed refusal lines; per-person daily limit.
- 1b (Hub web): rename and pin the chat, empty state and suggested questions, agent cards with Ask and Add to a room.
- 1c (Hub web, admin): "Hub AI" page: Hub General switch, who, limit, usage split.
- 2a (Hub server): read-only lookups for people, teams and agents, as the asker; lookup budget per question.
- 2b (Hub web): person and team cards.
- 3a (Hub server): administrator lookups; page links on answers. Depends on the overview page.
- 4a–4c: as plan 1.6 item 10b (management tools, confirmation cards, entry points).
