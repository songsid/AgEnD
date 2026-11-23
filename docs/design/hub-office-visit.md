# Offices on the Hub: visit a colleague's office, and a room's own office (M-3460)

Status: design for the owner's approval, third revision (2026-11-20). After the owner's feedback: the room office is
a tab of the chat page with no extra row and no frame; the tabs sit where the Fleet puts Chat / View; on a phone
the office is in the "…" menu; the room's purpose is shown as a small card with the room's picture, like an
agent's card on its chat page; and the member list was checked at 12 people and 30 agents. No product
code. The captures are a throwaway prototype in the real app (see "Prototype captures").

Two things are asked for, and they share one drawing:

- **A person's office.** A colleague opens their Fleet's office to chosen people on the Hub. Visitors see the
  owner's real office: its layout, its style, every agent in it.
- **A room's office.** A Hub chat room has an office of its own. The agents in that room sit in it, each looking
  the way its owner made it look.

## What exists today (facts this builds on)

From `docs/office.md` and `src/office-share.ts` on the development branch (98cfd9b77):

- An office share link shows the live office to people outside the fleet, with no sign-in, for 15 minutes to 24
  hours. The view is built for the share alone: names, identity colour, state and level. No chat, model, cost,
  description, last reply or what an agent waits on. An agent with `cross_instance_visibility: hidden` is never
  in it. An agent's own status line shows only when the sharer ticks it.
- It updates every 5 seconds. A person's card shows name, title, state, office and level.
- Pat, Feed and dragging are on the owner's own dashboard only, kept on that device, and are not on a share link.
- On the Hub: owners share agents and choose who may ask (people, AD groups, teams); they can pause and stop.
  An agent joins a room only with its owner's consent.

Not checked by me: how much the Fleet-to-Hub connection can carry (skin packs are up to 20 MiB each). The slice
plan keeps pack pictures out of the first slices for that reason; a builder should confirm before slice 4.

## Part 1. Visiting a person's office

### 1.1 The owner turns it on

- **Where:** Hub → My agents → the Fleet's group → a new row, **Office**. It says "Not shared on this Hub" with
  **Share office…**, or what is shared and with whom, with **Change…**.
- **Why there and not in the Fleet's Office bar:** who may visit is chosen from Hub people, groups and teams,
  which only the Hub knows. It also matches the decision that sharing is done from the Hub page (2101c5b2).
- **Needs:** the Fleet's existing switch "Let me share agents from the Hub page", and the same permission as
  sharing an agent. No new permission.
- **The dialog asks three things:**
  1. Which office: one stored office, or Whole fleet. One choice per Fleet.
  2. Who may visit: "Everyone who can use this Hub", or "Only these groups, teams or people" (the picker used
     for "Who may ask").
  3. "Also show the status lines agents write themselves" (off unless ticked, as on a share link).
- **It says plainly what visitors get** (the paragraph in the dialog capture).
- **The Fleet is told:** a notice in its General with Undo, as for sharing an agent from the Hub.

Off by default. Nothing is visible on the Hub until the owner does this.

### 1.2 What a visitor sees

Exactly what a share link shows, nothing more: the scene, each agent's name, look, state and level, and the
letters and folders that fly between them. No words: the dialogue box says "Someone sent Atlas a message", never
what or who. Hidden agents are absent. The owner's ticked status lines, if any.

One addition, because the visitor is a known Hub member: on the card of an agent **this visitor may already
ask**, an **Ask** button opens the Hub chat with it. For other agents the card has no button.

Visitors see agents the owner has not shared on the Hub (their names and states). That is the same as a share
link and the dialog says so. See question Q2.

### 1.3 Live or a snapshot

Live, every 5 seconds, **only while someone is looking**. The Hub tells the Fleet when the first visitor opens
the office and when the last one leaves; in between the Fleet sends nothing. When the Fleet is offline the
office is "Closed · last open 2 hours ago" and cannot be entered. No stale picture is kept: an old picture of
who is working would be wrong and would look current.

### 1.4 Stopping, and no expiry

- **Stop sharing** in the same dialog: visitors' pages show "This office is closed" within 5 seconds.
- Removing a person, group or team from the list takes effect on that person's next 5-second read.
- It also ends when the Fleet leaves the Hub, the owner loses the right to share, or the chosen office is
  deleted (it closes; it does not fall back to Whole fleet).
- **No expiry.** A share link expires because the link itself is the key and can leak. Here every visitor is
  signed in and named by the owner, so a time limit protects against nothing and would only make owners re-share.

### 1.5 What visitors can do

| | First build | Later, if wanted |
|---|---|---|
| Look, zoom, fit, full screen, open a card | Yes | |
| Ask an agent they may already ask | Yes | |
| Pat and Feed | No | Local only: hearts on the visitor's own screen, nothing sent to the owner or the agent |
| Drag people around | No | No: it is the owner's room |
| "Tell the agent" about a pat | No | No. It would put a stranger's action into an agent's next message, which costs the owner tokens and is a way to write into someone else's agent |

The owner seeing who is visiting ("2 visiting: Alex, Casey" in their Office bar) is a later option; see Q4.

### 1.6 Where it is on the Hub

A side-bar item **Offices**, shown to a person who can visit at least one office or who has a Fleet. The page
lists the offices open to you (owner, office name, how many agents and how many working, Open now or Closed) and
your own office's state with a link to My agents. Opening one shows the office filling the page, with no box
around it, under a crumb back to Offices (`a.hub-crumb`, as other Hub sub-pages).

### 1.7 Limits

| Limit | Value | What it protects |
|---|---|---|
| Shared offices per Fleet | 1 | Keeps the owner's choice and the Fleet's work simple |
| Updates | Every 5 seconds, only while watched | The Fleet's link and CPU |
| One update's size | 256 KB | The Hub and the link |
| Visitors at once | No limit | One stream from the Fleet serves every visitor, so a cap protects nothing |
| Pack pictures kept by the Hub | Each picture once, by its content; a total cap set by the Hub administrator | Hub disk |

A Hub administrator can turn the feature off for the Hub. An administrator cannot enter an office that was not
opened to them.

## Part 2. A room's office

### 2.1 A room setting, and where the office is

Room settings → **Room office** (on or off) and its **style** (the built-in styles). Room managers change it.
A line in the room says when it was turned on or off. See Q5 for the default.

**The office is a tab of the room's page, the same tab bar an agent's page has** (Chat / View / Log there;
**Chat / Office** here; `nav.inst-switch.seg`, the dashboard's own component):

- **Desktop:** the tabs are at the right of the room's header row, just before the header's tools, where the
  Fleet agent page puts Chat / View / Log. No row is added.
- **Phone:** no tabs. **Office** is the first item of the room's "…" menu. In the office, the header's second
  line says "Office" and the back arrow returns to the chat. The office is not important enough to take a row on
  a phone.
- The office fills the content area the way View does: no card, no border, no inner title bar, and no message
  box under it. To ask something, a member goes back to Chat, or presses **@** on an agent's card, which
  switches to Chat with the mention already in the box.
- With Room office off, there is no tab bar and no menu item.

### 2.1a The room's header and its purpose (changes today's room page too)

Today the room's header is three lines at the top left: the name, the purpose (or "Add a purpose"), and
"12 people · 30 agents" (capture `r3-0`). On a phone the purpose is not in the header at all; it is only in the
members sheet.

Changed, following the Fleet agent page:

- **The header is one line:** the room's name with "12 people · 30 agents" beside it, as an agent's name has its
  state beside it. Then the tabs and the tools at the right.
- **The purpose is a small card under the header**, the same strip an agent's chat page uses for its identity
  card (`.chat-card` with `.id-card.card-c`): the room's picture on the left, "Purpose" and the text beside it.
  It wraps to as many lines as it needs. A room manager has **Edit** at its right.
- With no purpose: a manager sees the card with "Add a purpose"; a member sees no card.
- The card is on the Chat tab only. On a phone it is the same card, so the purpose is finally visible there.
- The room's square picture moves from the header into the card on desktop. On a phone the header keeps its
  back arrow and two lines (name, counts) as today.

### 2.1b Who may change a room's office, and how (owner's decisions, 2026-11-20)

- **Room managers** choose the scene style and arrange the seats, in Room settings. **Members cannot.**
- **No tool for agents.** There is no MCP tool to edit a room's office; it is rare, and the tool list should not
  grow for it. Managers do it in the page.
- **A person's office is edited only in its owner's own Fleet.** The Hub's part is sharing: which office, who may
  visit, stop.

**Room settings → Room office** (captures `r4-1`):

1. **Show the room office**: on or off.
2. **Style**: the built-in zones styles, each with its number of seats, so a manager can see whether the room
   fits. A new built-in style for large rooms, **Studio (large)**.
   **Corrected 2026-11-23 after the builder's check.** I first asked for 36 work seats. The builder confirmed
   Studio is drawn in code (no artwork needed) on a fixed 1280×720 canvas, and the captures of the 30-agent room
   show what really runs out: three or four agents are at desks while about 25 stand in a rest area with 14
   seats, because agents are idle most of the time. So the large style keeps 12 desks and gives the rest area
   about 30 seats, spaced at least one name label apart, on the same canvas: about 57 seats against Studio's 41.
   The list shows total seats, and a room with more agents than the chosen style has rest seats is told that a
   larger style gives everyone a seat.
3. **Arrange seats…** opens the room's office with the Fleet's own layout editor.

**The model is the Fleet's, reused** (captures `r4-5`, `r4-6`, the real Fleet editor today):

| Fleet office | Room office |
|---|---|
| A stored office: name, style, members, layout overrides | The same record, kept by the Hub for the room. The name is the room's; the members are the room's agents and cannot be picked separately |
| Edit offices: style, "Idle people stay in their own area" | The Style field and the same tick box in Room settings |
| Edit layout: drag seats, furniture, the door, the mail drop and waypoints; Save, Reset to the style's layout, Cancel | The same editor, opened by "Arrange seats…" |
| A seat's "Reserved for" and "Lend when away" | The same, choosing from the room's agents |
| The host checks every save: seats stay inside their area, each area keeps its seat count | The Hub runs the same check |
| Two people saving at once: "Keep my edits" or "Load theirs" | The same, between two managers |
| Uploaded skin packs | Not in a room office in the first builds: built-in styles only |

Seats cannot be added by a manager (an area keeps its seat count, as on the Fleet); more seats come from
choosing a larger style. When an agent leaves the room, a seat reserved for it becomes free.

A line in the room says who changed the style or the seats. One thing to fix while reusing the editor: its
"Reserved for" list is a wall of tick boxes when there are 30 agents (capture `r4-6`, phone); it needs the same
filter box as the member list.

### 2.2 Who appears

Exactly the agents that are members of the room, plus the room assistant. An agent that joins or leaves the room
appears or disappears at once. People are not drawn in the first build.

No new consent is needed for an agent to appear: its owner already agreed to put it in this room, and members
already see its name, owner and introduction. Its working state is not new either: today's member list already shows every agent as working, idle, paused or
offline to all room members.

**Corrected 2026-11-23 (found by the builder).** An earlier version gave each owner a per-agent switch, "Show its
look and whether it is working in room offices", naming the threat as members learning that an agent is busy
outside the room. The member list already shows that, so the switch protected nothing. The office now shows
exactly the member list's states and the two never disagree. **The owner decided on 2026-11-23 to drop the switch:**
an agent's look always goes with its sharing into room offices. There is no per-agent setting for room offices.

### 2.3 How an agent's look travels

When an agent is shared on the Hub, its Fleet sends a small **look card** with it, and again when the look
changes:

- its identity colour;
- its portrait, or else its avatar (identity-card picture, bot avatar or persona emoji), or else its initial;
- its own character pictures from the owner's skin pack, when the pack gives it some.

Never sent: the pack as a whole, the owner's office layout, other agents, file names or paths, models, anything
from the Fleet's settings. Pictures are named by their content and capped (512 KB an agent in total). The room
itself is drawn by the Hub in a built-in style; nothing of any owner's office is in it.

So Atlas looks the same in its owner's office, in every room office, and in the room's member list.

### 2.4 Live state

| Shown | Where it comes from |
|---|---|
| Answering in this room | The Hub knows: it sent the question |
| Working, idle, paused | The same presence the room's member list shows today, in the same words |
| Away (asleep) | Offline in the member list |

"Answering in this room" is the useful one and needs nothing new from the Fleet.

### 2.5 What members can do there

- Look, zoom, open an agent's card: name, owner, introduction, state.
- **@ it** from the card: switches to the Chat tab with the mention in the message box.
- The dialogue box may show words here, unlike a visit: the first ~120 characters of a question and its answer
  **from this room**, which every member can already read in the chat.
- Pat and Feed: later, local only, as for a visit.

### 2.6 A large room: 12 people and 30 agents

Checked in the real app with a room of 12 people and 30 agents of 6 owners.

**The office** holds all 30 in the built-in style: the ones working sit at desks and the idle ones stand in the
rest area, where their name labels start to overlap (capture `r3-2`). A style with more seats would read better
for a room this size. On a phone it is
small until zoomed, which is the framing in this prototype; a real build fits the width.

**The member list today** (captures `r2-6`, `r2-7`): every person takes two lines and every agent two or three,
so the list is about 3,600 px tall, more than four desktop screens. The 12 people fill the first screen and the
first agent is below it. Agents fold after 8 with "24 more", and unfolding gives the full length. On a phone the
sheet shows 10 people and nothing else. It works, but nobody can find one agent in it.

**Proposed** (captures `r2-8`, `r2-9`), used only when a room has more than 12 people and agents together; a
small room keeps today's list:

| Change | What it does |
|---|---|
| One summary line | "12 people, 7 online · 30 agents of 6 owners" at the top |
| A filter box | Type a name or an owner; groups open and only matches show |
| One line a row | Name on the left, state on the right. An agent's introduction and owner move into its card, which opens on a press as today |
| People not online are folded | "Not online · 5", closed until pressed |
| Agents grouped by owner | "Example owner · 5", closed until pressed, so 30 agents are 6 lines |

The same room is then about 630 px: everything is on one desktop screen, and on a phone the people and the
first owner's agents are on the first screen. Size S–M, and it is independent of the office, so it can ship
on its own.

### 2.7 How the two relate

| | A person's office | A room's office |
|---|---|---|
| Whose place | The owner's real office: their layout and style | The Hub's: a built-in style chosen by the room |
| Who is in it | Every agent in that office of that Fleet | The room's agents, from any number of owners |
| Who decides who sees it | The owner | Room membership |
| Words | Never | Only this room's own messages |
| What leaves the Fleet | The pruned office view, while watched | A look card per shared agent, and its one-word state |

From an agent's card in a room office: "Visit {owner}'s office", shown only when that owner has opened their
office to you. Sharing an office puts no agent in any room, and joining a room opens no office.

## Fit with the Hub's decisions

- **Internal Hub, company sign-in only:** every visitor is a signed-in colleague; there is no link to pass on.
- **The owner's agents speak:** nothing here answers for an agent or acts on it. The only action is "Ask", which
  is today's question to an agent the person may already ask.
- **Roles:** sharing an office uses the permission for sharing agents; visiting needs none. No new role.
- **Every gate names a threat:** opt-in (work patterns are the owner's to show), the audience list (the same),
  no words (messages are private). Left out because
  they name none: expiry, a visitor cap, an approval step, a visit log.

## Prototype captures

In `docs/evidence/hub-office-visit-m3460/`: desktop (light) and phone (dark) in zh-TW, and the same in English.

| File | What it shows |
|---|---|
| `*-1-offices.png` | The Hub's Offices page |
| `*-4-owner-row.png` | The owner's Office row on My agents |
| `*-5-owner-dialog.png` | The owner's share dialog |
| `*-r2-2-visit.png` | Visiting a person's office, filling the page with no box (zh-TW) |
| `*-r3-0-room-today.png` | Today's room header with a purpose, unchanged app (zh-TW) |
| `*-r3-1-room-chat.png` | The room in Chat: one-line header, tabs at the right (desktop), the purpose card (zh-TW) |
| `*-r3-2-room-office.png` | The room in Office: 30 agents, no extra row, no frame (zh-TW) |
| `phone-zh-TW-r3-3-room-menu.png` | The phone's "…" menu with Office first |
| `*-r4-1-room-office-setting.png` | Room settings with the Room office section: switch, style, Arrange seats (zh-TW) |
| `desk-zh-TW-r4-5-fleet-edit-offices.png` | The Fleet's real Edit offices panel today (the model reused) |
| `*-r4-6-fleet-edit-layout.png` | The Fleet's real Edit layout today, a seat selected with "Reserved for" (the editor reused) |
| `*-r2-6-members-today.png`, `*-r2-7-members-today-expanded.png` | Today's member list with 12 people and 30 agents (zh-TW) |
| `*-r2-8-members-proposed.png`, `*-r2-9-members-filter.png` | The proposed compact list, and the filter (zh-TW) |

What is real and what is not:

- The Hub is the real one (real server, database and pages) at 98cfd9b77. The office is the real office share
  page, fed by a made-up fleet. Names are made up.
- The Offices page, the Office row, the dialog and the compact member list are prototype code served to the
  browser for the capture only. The room's tabs and the purpose card use the dashboard's real
  classes (`inst-switch seg`, `chat-card`, `id-card card-c`), put into the real room page for the picture; the
  "Office" menu item is a one-line change to the real menu, in the browser only.
- The office is the real share page placed inside the Hub page with its own title bar and office picker hidden.
  Its row of tick boxes is the office's own bar, as on the Fleet. On a phone the office is small because the
  share page is framed; a real build draws it directly and fits the width.
- Everyone has the default look, because the made-up fleet has no skins; carried looks are not shown.
- The Room office section in Room settings is put into the real dialog for the picture. The two editor captures
  are the Fleet dashboard's real editor on a scratch fleet with made-up agents, not a Hub page: they show what
  would be reused, not the room's editor itself. "Studio (large)" does not exist yet and is not drawn.
- The room has 12 people and 30 agents of 6 owners, all made up; 5 of the people have never signed in.
- Not captured: a closed office's page, an agent's card. (The per-agent switch was dropped later.)

## Checked against the style guide

`docs/design/ui-style-guide.md` on the development branch:

- **Rule 13 (the Hub's shell is the dashboard's):** Offices is a row in `HubSide` (`a.side-row` with an icon);
  the page is named once in `PanelHeader` and opens with its lead; its cards are in the page's column; a visit
  uses `a.hub-crumb`. The room's tabs are the dashboard's `nav.inst-switch.seg`, not a Hub-only control.
- **Rule 1 (shared components):** the dialog is the shared `Dialog`; the list rows are `s-row hub-row`.
- **Rule 2 (one card frame):** the office has no frame of its own, in a room or on a visit.
- **Rule 7 (phone and desktop, no sideways scroll):** every capture is at 1366 and at 390 wide.
- **Rules 4 and 5 (tokens, no inline styles):** the prototype breaks these in places (it is not product code);
  the build must not.

## Slice plan (after approval)

| Slice | What | Size |
|---|---|---|
| M1 | The compact member list for large rooms (summary, filter, one-line rows, folded groups) | S–M, independent |
| R1 | Room office: the setting, the built-in scene, the room's agents as avatar or initial, the member list's states plus "answering in this room" | M |
| R1b | The style choice with seat counts, and the "Studio (large)" style | S–M |
| R3 | "Arrange seats…": the Fleet's layout editor on a room's office, managers only, with the Hub's save check | M |
| R2 | Look cards from the Fleet (colour, portrait, character pictures). Working and idle moved to R1 (they are the member list's states). No per-agent switch (dropped by the owner) | M |
| V1 | Visit a person's office: the owner's row and dialog, the Offices page, the live view in built-in styles, stop | L (split: Fleet side, Hub side, page) |
| V2 | Custom skin packs in a visited office (pictures carried once, kept by the Hub) | M, after a builder confirms what the link can carry |
| V3 | "Ask" on a card; "Visit {owner}'s office" from a room office | S |
| Later | Pat and Feed (local), the owner seeing who is visiting, people drawn in a room office | |

R1 comes first: it needs nothing new from any Fleet, and it shows the idea to everyone in a room at once.

## Questions for the owner

**Answered by the owner on 2026-11-23: all six as recommended** (「6 題都照建議」, relayed by the leader). The
recommendation column below is therefore the decision.

| # | Question | Recommendation (now the decision) |
|---|---|---|
| Q1 | Who may visit by default? | **Nobody until the owner chooses**, with "Everyone who can use this Hub" one click away |
| Q2 | Should visitors see agents the owner has not shared on the Hub? | **Yes**, as on a share link, and say so in the dialog. The other choice (only shared agents) leaves most offices half empty |
| Q3 | Pat and Feed for visitors and room members | **Not in the first build**; later, on the visitor's own screen only |
| Q4 | Should the owner see who is visiting? | **Later, yes**: a count and names in their Office bar. Being watched without knowing is the one uncomfortable part of this feature |
| Q5 | Is a room's office on when a room is made? | **On**, with the setting to turn it off. It shows nothing members cannot already see except the look (the clause about owners controlling the look and state is out of date: the per-agent switch was dropped). Relayed by the leader as on for existing rooms too |
| Q6 | Build order | **Room office first (R1, R2), then visiting (V1)** |

## 給擁有者的摘要（zh-TW）

**兩件事，同一種畫面：**

**第三版（依你第二輪回饋）：** ① 手機不放分頁，「辦公室」收進右上「…」選單的第一項；進入後標題第二行顯示
「辦公室」，返回鍵回到聊天。② 桌面版的「聊天／辦公室」分頁放在標題列右側、工具按鈕前面，和 Fleet 的 Agent
頁面放「聊天／檢視」的位置一樣。③ 房間用途不再擠在左上角三行：標題列改成一行（名稱＋「12 人 · 30 個 Agent」），
用途改成標題下方的一張小卡片（房間圖示＋「用途」＋內容），就是 Agent 聊天頁放頭像與介紹的那種卡片；管理員
右側有「編輯」。這同時改了現在的房間頁面，手機上也終於看得到用途。

**編輯權限（你的決定）：** 房間管理員可以在「房間設定 → 房間辦公室」選場景風格、排座位；一般成員不能改；
不新增讓 Agent 編輯辦公室的 MCP 工具。個人辦公室只能在擁有者自己的 Fleet 編輯，Hub 只管分享。
設計上直接沿用 Fleet 辦公室編輯器的模型：同一種「辦公室」資料（名稱、風格、座位覆寫）、同一個「編輯配置」
畫面（拖曳座位、指定「保留給」誰、不在時借給別人）、同樣的儲存檢查。成員名單固定是房間裡的 Agent。
另外新增一個大房間用的內建風格「工作室（大）」：休息區約 30 個座位（現在的工作室是 14 個；實測 30 個 Agent 的房間不夠的是休息座位，不是辦公桌），30 個 Agent 的房間
會建議用它。座位數不能自己加，要更多座位就換大的風格。

**第二版（依你的回饋修改）：** 房間的辦公室改成房間頁面上的一個分頁，和 Agent 頁面的「聊天／檢視／紀錄」
是同一種分頁列：桌面版放在標題列裡，不多一排；手機版和 Agent 頁面一樣在標題下方。辦公室直接佔滿內容區，
沒有外框、沒有另外的標題列，下面也不再放輸入框。另外實測了 12 人、30 個 Agent 的房間：現在的成員清單長約
3,600 px（四個畫面以上），建議超過 12 個成員時改成精簡清單——一行統計、篩選框、每人一行、不在線上的人收合、
Agent 依擁有者分組收合——同一個房間變成約 630 px。

1. **參觀同仁的辦公室。** 擁有者在 Hub 的「我的 Agent」→ 自己的 Fleet → 新的「辦公室」列，按「分享辦公室…」，
   選哪一間、誰可以參觀（所有人，或指定的群組、團隊、人員）。預設不分享。參觀的人看到的和現在的辦公室分享連結
   一樣：場景、每個 Agent 的名稱、外觀、狀態、等級；看不到任何訊息內容、模型、費用。設為隱藏的 Agent 不會出現。
2. **房間自己的辦公室。** 每個 Hub 房間可以有一間辦公室（房間設定裡開關、選風格）。裡面坐的就是這個房間的
   Agent，各自帶著擁有者替它設定的外觀。會顯示「正在這個房間回答」、工作中、閒置、休息。成員可以點 Agent 看
   名片、按 @（會切回聊天分頁並帶入提及）；對話框只會顯示這個房間自己的訊息。

**即時還是快照：** 即時，每 5 秒更新，而且只有有人在看的時候 Fleet 才送資料。Fleet 離線時顯示「休息中」，
不留舊畫面。

**停止與期限：** 擁有者隨時可以停止，5 秒內生效。不設期限：分享連結要期限是因為連結會外流，這裡每個參觀的人
都是登入的同仁、由擁有者指定，期限擋不到任何風險。

**參觀的人能做什麼：** 第一版只能看、縮放、開名片，以及對「本來就能問」的 Agent 按「提問」。摸頭、餵食之後
再做，而且只顯示在自己的畫面上，不會通知擁有者或 Agent。

**外觀怎麼帶過來：** Agent 分享到 Hub 時，Fleet 一併送出一張小小的「外觀卡」：識別色、頭像、它自己的角色
圖。不會送出整個外觀包、辦公室配置、其他 Agent 或任何 Fleet 設定。

**要請你決定：** Q1 預設誰可以參觀（建議：擁有者選了才有）；Q2 參觀時是否看得到沒有分享到 Hub 的 Agent
（建議：看得到，和分享連結一樣，並在對話框說明）；Q3 摸頭／餵食（建議：之後再做）；Q4 擁有者是否看得到誰在
參觀（建議：之後做）；Q5 新房間的辦公室預設開或關（建議：開）；Q6 先做哪個（建議：先做房間辦公室）。

**截圖說明：** Hub 和辦公室畫面都是真的程式跑出來的；「辦公室」頁、分享列和對話框是只為截圖寫的原型。
辦公室是把分享頁嵌進 Hub 頁面，所以多了一排分享頁自己的工具列，正式版不會有，手機上辦公室也會放大到滿版。
