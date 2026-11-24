# Hub and Fleet, feature by feature: chat and office (M-3670)

Checked in the real app on the dev tip `a12b8fe32` (2026-11-25), headless, with made-up people and agents.
Captures, the recorded observations and the two scripts are in `docs/evidence/hub-vs-fleet-feature-table-m3670/`.
This branch is never merged.

**How to read it.** ✓ has it. ✗ does not. "part" has some of it. The **Gap** column says why a ✗ or "part" on
the Hub side exists:

- **by decision**: the owner or the design chose it (for offices: "the room office stays basic", 2026-11-24);
- **missing**: nobody decided against it; it is not built;
- **n/a**: the feature belongs to one product only.

The **How** column: "used" means I did it in the page; "seen" means the control or text was on the page and I did
not operate it; "builder" means the builder read it in the code for me and I did not see it myself.

## Summary

- **Chat, Fleet against a Hub group room: close to equal.** Writing, files, quoting, pins, links, buttons, polls
  and search work the same. The room adds reactions and @mentions. The remaining differences are by design.
- **Chat, Hub one-to-one: four things are missing.** Buttons and polls from an agent do not show; search does not
  cover one-to-one messages; there is no Pin; there are no reactions. None was decided against; the one-to-one
  page was left out of scope when rooms got them.
- **HTML preview on the Hub is not confirmed.** Both Hub pages showed the HTML card with "Open in panel" and the
  note "Previews are off in this browser. Allow them from the card's menu." I could not open that menu in the rig,
  so whether Preview then runs is not verified.
- **Office: the room office is the basic one, by decision.** It has the scene, zoom, fit, fill, fullscreen and a
  short card. Everything else in the Fleet office is absent by the 2026-11-24 decision.
- **One bug found on the way:** in the room office the zoom buttons are announced to screen readers as
  "orgc.zoomIn" and "orgc.zoomOut" (raw text keys), on desktop and phone.

## 1. Chat

| Feature | Fleet chat | Hub room | Hub 1:1 | Gap | How |
|---|---|---|---|---|---|
| **Composer** | | | | | |
| Enter sends, Shift+Enter adds a line, with the hint under the box | ✓ | ✓ | ✓ | | used |
| Input method: Enter while composing does not send | ✓ | ✓ | ✓ | | used (browser composition events) |
| Slash commands (`/ctx`, `/model`, `/effort` …) | ✓ | ✗ | ✗ | n/a: they control one agent's session | used |
| @ mention list | ✗ | ✓ (all agents, each agent, each person) | part (the agent only) | n/a for Fleet | used |
| Model picker and "Not verified" in the box | ✓ | ✗ | ✗ | n/a | seen |
| **Files** | | | | | |
| Paste a picture | ✓ | ✓ | ✓ | | used (real clipboard) |
| Paste a very long text: becomes a text file, with a notice | ✓ | ✓ | ✓ | | used |
| Drop a file on the conversation | ✓ | ✓ | ✓ | | used (a browser drop event, not a drag from the desktop) |
| A person's picture shows inline | ✓ | ✓ | ✓ | | used |
| A person's HTML file is a plain file chip | ✓ | ✓ | ✓ | | used |
| An agent's HTML file: card with Open in panel | ✓ | ✓ | ✓ | | seen |
| An agent's HTML file: Preview in the conversation | ✓ | not confirmed | not confirmed | see Summary | used on Fleet; on the Hub the card says to allow previews from its menu, which I could not open |
| An agent's picture | ✓ | not checked | not checked | | Fleet used; my Hub fixture could not send one |
| **Replies and message actions** | | | | | |
| Reply to a message | ✓ | ✓ | ✓ | | seen in the menu |
| Quote selected text | ✓ | ✓ | ✓ | | used |
| Copy text, Copy link | ✓ | ✓ | ✓ | | seen in the menu |
| Pin, with a pinned-messages list | ✓ | ✓ | ✗ | **missing** | used on Fleet and room; absent from the 1:1 menu; builder: pins are read for group rooms only |
| Reactions by people | ✗ (the agent's own reaction shows) | ✓ | ✗ | **missing** for 1:1; n/a for Fleet | seen; builder: reactions need a group room |
| **Buttons and polls from an agent** | | | | | |
| Buttons: press one, the others switch off, "Chosen by …" | ✓ | ✓ | ✗ | **missing** | used; in the 1:1 the answer text shows and the buttons do not; builder confirms the page drops them while the Hub stores them |
| Poll: vote, count and time left | ✓ | ✓ | ✗ | **missing** (same cause) | used |
| **Links** | | | | | |
| A web address is a link that opens in a new tab; no preview card | ✓ | ✓ | ✓ | | used |
| **Search (Ctrl K)** | | | | | |
| Finds messages by a word and opens the hit | ✓ | ✓ | ✗ for 1:1 messages | **by decision for now**: the search design left one-to-one out as a follow-up | used: from a 1:1, a word present in two 1:1 messages returned only the two room matches |
| Filters in the search dialog | ✓ | ✗ | ✗ | missing (small) | seen |
| **Status** | | | | | |
| A line that the agent is working or queued | ✓ | ✓ ("Notes is working on it") | ✓ ("Sent to Notes; waiting for it to start") | | seen |
| Steps and tool receipts of the agent's turn | ✓ | not checked | not checked | n/a expected: a Hub asker does not see an owner's agent's steps | not walked |
| **Header and menus** | | | | | |
| Full width | ✓ | ✓ | ✓ | | seen |
| Agent controls (details, split chat, restart, stop, files and changes, colour, theme, delete) | ✓ | ✗ | ✗ | n/a: they act on your own agent | seen |
| Room controls (members panel, purpose, leave room, room settings for managers) | ✗ | ✓ | ✗ | n/a | seen; room settings not opened (the viewer was not a manager) |
| Mute this agent's own messages | ✗ | ✗ | ✓ | n/a | seen |
| Notifications bell for this chat | ✗ (set in Settings) | ✓ | ✓ | by design | read in the page code (the Hub chat header); not operated |
| **Phone** | | | | | |
| Header | one row, 48 px (name, state) | one block, 57 px (name; people and agents) | one block, 57 px (avatar, name, owner) | | seen (390 px wide, zh-TW, dark) |
| Chat / Office switch | n/a | not in the header row on a phone | n/a | by design (in the menu) | seen: no tab row on the phone; menu not opened |

## 2. Office

Every gap in this table is **by decision**: on 2026-11-24 the owner decided the room office stays at its basic
feature set, and new Fleet office features are not brought over unless asked.

| Feature | Fleet office | Hub room office | Gap | How |
|---|---|---|---|---|
| **Where it is** | Fleet › Org chart › Office (beside Canvas and List) | The room's Office tab (desktop); on by a room setting | | used |
| **Views** | | | | |
| The scene with each agent at a seat | ✓ | ✓ | | used |
| Zoom in, zoom out, fit, fill, fullscreen | ✓ | ✓ | | seen (same five buttons) |
| Area pills on a phone (Overview, Lounge …) | ✓ | ✓ | | seen |
| Canvas and List views of the same agents | ✓ | ✗ (the room has its member list) | by decision | seen |
| Office picker, several offices, all-offices overview | ✓ | ✗ (one office per room) | by decision | seen; builder for the overview |
| Team filter, find box, People list | ✓ | ✗ | by decision | seen |
| Live traffic between agents | ✓ | ✗ (the room refreshes every 5 s) | by decision | seen; builder for the refresh |
| **Styles and seats** | | | | |
| Built-in styles | Desks, Studio, Cozy, Guild, School | Studio, Studio (large), Cozy, Guild, School | by decision (no Desks; the room adds Studio large) | Fleet used; room list from the builder, room settings not opened |
| Who sets the style | Display options in the office | Room settings, managers only | by design | Fleet used; room builder |
| Edit offices: add, rename, members, seats and layout | ✓ | ✗ | by decision | seen (Edit offices button); builder |
| **Packs and characters** | | | | |
| Skin packs as an office style | ✓ | ✗ | by decision | builder |
| An agent's own character from its owner's pack | ✓ | ✓ since `a12b8fe32` (on user-look hold) | | builder and its captures; my room had no pack |
| Levels and work tokens | ✓ | ✗ | by decision | seen on the Fleet card |
| **Talk** | | | | |
| Talk modes: pop-up window, side panel, dialogue box, over their head | ✓ | ✗ | by decision | seen |
| Agents' words shown in the scene | ✓ | ✗ | by decision | builder |
| Calling and stuck bubbles | ✓ | probably the same (shared drawing) | | not checked |
| **Interactions** | | | | |
| Pat, Feed, snacks | ✓ | ✗ on the card | by decision | seen: the room card has no Pat or Feed; not checked whether the scene itself allows it |
| "Tell <agent> (with their next message)" | ✓ | ✗ | by decision | seen |
| Drag a seat | ✓ | not checked | | builder unsure |
| Share the office by link | ✓ | ✗ | by decision | seen |
| **The agent's card** | | | | |
| Name and state | ✓ | ✓ | | used |
| Owner and introduction | ✗ | ✓ | room only | used (owner; my agent had no introduction) |
| Level, office and area, model, backend, today's tokens and requests, "Now: …" | ✓ | ✗ ("answering in this room" when it is) | by decision | used on Fleet; room state from the builder |
| Find in office | ✓ | ✓ | | seen |
| Open its chat | ✓ (new window) | ✓ ("@ it": back to Chat with the mention) | | seen |
| **Room only** | | | | |
| The room assistant's seat | ✗ | ✓ | n/a | builder |
| Office on/off for the room, posting a line when changed | ✗ | ✓ | n/a | builder |
| **Phone** | | | | |
| Card as a bottom sheet | ✓ | ✓ | | used |
| "More actions" sheet (fit, fill, fullscreen, office, team, People, style, talk mode) | ✓ | ✗ (nothing more to put in it) | by decision | used on Fleet |

## 3. Found on the way

| What | Where | Size |
|---|---|---|
| Zoom buttons in the room office are announced as "orgc.zoomIn" / "orgc.zoomOut" instead of "Zoom in" / "Zoom out" | Room office, desktop and phone, both languages | S (bug) |
| Buttons and polls from an agent do not show in a one-to-one | Hub 1:1 | S–M |
| One-to-one messages are not searchable | Hub search | M |
| No Pin and no reactions in a one-to-one | Hub 1:1 | S each |
| No Filters in Hub search | Hub search | S |

## 4. Not checked

- HTML preview on the Hub after allowing it from the card's menu.
- An agent-sent picture on the Hub (my fixture could not send one).
- Steps and tool receipts, split chat, text size, voice.
- Room settings as a manager, the phone's menu, the room assistant's seat.
- Calling and stuck bubbles, Pat and Feed in the room's scene, seat dragging.
- A drag from the desktop (only a browser drop event was used).
- Safari and a real phone: everything here is headless Chromium.

## 5. 給使用者的摘要（zh-TW）

- **聊天：Fleet 和 Hub 群組房間幾乎一樣。** 輸入、貼圖、貼長文、拖檔、引用、釘選、連結、按鈕、投票、搜尋都相同。房間多了表情回應和 @ 提及。其餘差異是設計上本來就不同（例如斜線指令只屬於自己的 Agent）。
- **Hub 一對一少四樣：** Agent 送的按鈕和投票不會顯示、搜尋找不到一對一的訊息、沒有釘選、沒有表情回應。這些都不是決定不做，而是當初只做了群組房間。
- **Hub 的 HTML 預覽尚未確認：** 卡片顯示「此瀏覽器已關閉預覽，請從卡片選單允許」，我在測試環境沒能打開那個選單。
- **辦公室：房間辦公室是基本版，這是 11/24 的決定。** 有場景、縮放、全螢幕和簡短的卡片；Fleet 辦公室其他功能（多個辦公室、編輯座位、外觀包當風格、對話模式、摸頭餵點心、等級、分享連結）都不帶過去。
- **順便發現一個錯誤：** 房間辦公室的縮放按鈕，螢幕閱讀器會念成「orgc.zoomIn」。
