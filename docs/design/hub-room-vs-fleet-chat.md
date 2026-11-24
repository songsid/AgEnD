# Hub room and Fleet web chat: where they differ today (M-3309)

Status: findings from use, for the owner. The rule being checked (decision 38e2ea2d): the Hub's conversation window
is the Fleet chat, copied in every detail.

## How this was checked

- Development tip `c891e8d41`, 2026-11-18. Both products ran for real in a headless browser inside WSL: the Fleet
  dashboard from the repo's scratch fixture (a real dashboard on a scratch home; no fleet, CLI or tmux started),
  and a real Hub server on scratch data (real HTTP and database, with the room assistant answering from a stub).
- The same actions were performed in each: pasting, dropping, attaching, typing `@` and `/`, Enter and Shift+Enter,
  opening message menus, replying, selecting text, reacting, pinning, scrolling back, searching.
- Desktop, English, light theme for the walk; phone, zh-TW, dark for the layout.
- **Limits, stated plainly.** Paste, drop and the input-method Enter were sent as browser events, not from a real
  clipboard, a real drag or a real input method. The scratch Fleet has no running agent, so a message sent there
  shows as not delivered; that blocked checking files and their viewer on the Fleet side. Fleet search stayed
  "off" in the scratch Fleet. Buttons and polls could not be staged by me in either product. These are listed
  under "Not verified" and are not counted as gaps or as passes.

## 1. Gaps: the Fleet chat has it, the Hub room does not

Ranked by how often a person would hit it.

| # | Feature | Fleet chat | Hub room | Suggested fix | Size |
|---|---|---|---|---|---|
| 1 | Paste a screenshot (Ctrl+V) | A file chip appears in the box ("screenshot.png 137 B") | Nothing happens | Use the Fleet composer's paste handling in the room composer. Already M-3308 | S |
| 2 | Drag a file onto the conversation | A file chip appears | Nothing happens | Same handler family as 1; do it in M-3308 | S |
| 3 | Paste a very long text | It becomes a text-file chip ("pasted-….txt 30 KB · As text"), with a notice "A long paste (31,230 characters) was attached as a text file" | No chip and no notice | Same rule and threshold as the Fleet. Check what the Hub's message limit does with a long paste left as text | S–M |
| 4 | Quote part of a message | Selecting text shows a "Quote" button | Selecting text shows nothing; only whole-message Reply | Bring the selection quote over; the room already draws quoted replies | S–M |
| 5 | Pin a message | "Pin" in the message menu; a "Pinned messages: 1" control appears | No Pin | Needs a decision first: in a room, is a pin personal or for everyone? Then the list and the menu item | M |
| 6 | Copy a link to a message | "Copy link" in the message menu | Not there | Room search already opens a message, so a link target exists; add the menu item | S |
| 7 | "Enter to send · Shift+Enter for a new line" hint | Under the box | Replaced by the "@agent" explanation; the Enter hint is gone | Show both, or show the Enter hint once the person has sent a message | S |
| 8 | Phone header | One row: back, name, state, menu | Three rows (name, "Add a purpose", people and agent count); the name sits against the top edge and the count is cut to "2 人 · 0 個 …" | One row for the name; purpose and counts move to one secondary line or into the members sheet | S |
| 9 | Full width | In the header menu | Not there (the room menu has only Room settings and Leave room) | Add "Full width" | S |

## 2. Differences that are intentional

| Feature | Fleet chat | Hub room | Why it is right |
|---|---|---|---|
| Typing `/` | A command list (/ctx, /compact, /clear, /model, /backend …) | Nothing | Those commands control one agent's session. A room has no session to control |
| Typing `@` | Nothing | A list of who can be mentioned (the room assistant, people, agents) | A Fleet chat is with one agent |
| Model picker in the box | Yes | No | A room does not choose an agent's model |
| "Not verified" beside the box | Yes | No | It is about this browser's authority over the Fleet |
| Reactions by people | None (the agent's own reaction to your message is shown) | "Add reaction" on every message, eight emoji, with counts | A room has several people; a Fleet chat has one |
| Notifications | Set in Settings → Notifications | A bell in the room header: "Notify me on this device" | Per room is the useful grain in a Hub |
| Header menu | Instance details, Split chat, Restart, Stop, Files & changes, Colour, theme, Delete | Room settings, Leave room | The Fleet items act on an agent |
| Members panel, purpose | None | Yes | A room has members |

"Split chat" and "Files & changes" are left out on purpose for now; a list of a room's files is a separate request
(see the follow-ups in `hub-room-agent-context.md`).

## 3. The same in both (checked)

- Attach button and the file chip in the box.
- Enter sends; Shift+Enter makes a new line; Enter while an input method is composing does not send.
- Reply to a message, with the reply bar above the box; Copy text; "Copy this reply".
- The message menu on your own message and on an agent's.
- Text formatting in an answer: bold, numbered list, table, code block with Wrap and Copy; a link opens in a new tab.
- Scrolling back loads earlier messages, and a "Latest" button returns to the end.
- Text size control in the header.
- Search with Ctrl K opens in both; in the room it found the six matching messages.

## 4. The six rows that were not verified, now checked by use (2026-11-24)

Second walk, on development tip `b4fdcac36`, same method: the real Fleet dashboard from the scratch fixture and a
real Hub server on scratch data, in a headless browser. This time the scratch Fleet's search index was started,
agent messages were put into the Fleet chat through the Fleet's own message and reply paths, and a shared agent
("Notes") answered in the Hub room over a real member link. Pictures are side by side, Fleet on the left, in
`docs/evidence/hub-room-vs-fleet-chat-m3309/`.

| Item | Fleet chat | Hub room | Result | Picture |
|---|---|---|---|---|
| Search results (Ctrl K, "nginx") | "2 results", each with a "Chat" badge and a two-line excerpt; a "Filters" button | "2 results" under the room's name, a one-line excerpt; no Filters | Works in both; opening a result jumps to the message and outlines it in both. Difference: no Filters and a shorter excerpt in the room | `row-search-results.png`, `row-search-opened.png` |
| A picture in a message | Drawn inline; pressing it opens the viewer (zoom, fit, Annotate, Open original) | The same, inside a bubble | Same | `row-image-inline.png`, `row-image-viewer.png` |
| An HTML file from an agent | A card "HTML · weekly-report.html" with Preview and Open in panel; Preview ran the page in a frame | The same card with Open in panel only, and the note "Previews are not available here."; no frame | **Gap (new, confirmed by the builder).** The group room page never loads the Hub's preview settings on a fresh page load; only the one-to-one Hub chat does. Opening a one-to-one chat first makes Preview appear in the room. Fix: load them when the room opens, with a test. Size S | `row-html-file-from-agent.png` |
| An HTML file sent by a person | A file chip only, no card | A file chip only, no card | Same | `row-html-file-from-person.png` |
| Buttons | Pressing "London" marks it, switches the others off, shows "Chosen by …" and adds my answer | The same; my answer quotes the question | Same | `row-buttons-pressed.png` |
| Poll | Pressing "Sunday" marks it and shows "1 answered" and the time left; the choice can still be changed | The same | Same | `row-poll-voted.png` |
| Link previews | A web address is a plain link that opens in a new tab; no preview card | The same | Same. Neither product draws link preview cards (confirmed in the code as well: there is no such feature) | `row-link.png` |
| Real clipboard | Ctrl+V of a picture put on the browser's clipboard: a chip "image.png" | The same | Same. A real clipboard paste this time, not a made-up event | `gap-1-paste-screenshot.png` |
| Real input method | While composing (browser composition, Enter sent with key code 229) nothing is sent; after committing, Shift+Enter adds a line and Enter sends both lines | The same | Same | `row-ime-composing.png`, `row-ime-sent.png` |
| Real drag | A file dropped on the conversation: the "Drop files to attach them" card, then a chip | The same | Same, but **still a browser event**: a drag from the operating system cannot be made in a headless browser (I tried the browser's own drag input; it delivered nothing in either product). One manual drag in a real browser remains | `gap-2-drop-file.png` |

### The nine gaps of section 1, retaken on `b4fdcac36`

One picture per gap. Most are closed since the first walk.

| # | Gap | Now | Picture |
|---|---|---|---|
| 1 | Paste a screenshot | Closed: a chip in both | `gap-1-paste-screenshot.png` |
| 2 | Drag a file onto the conversation | Closed: a chip in both | `gap-2-drop-file.png` |
| 3 | Paste a very long text | Closed: the text-file chip and the notice in both | `gap-3-long-paste.png` |
| 4 | Quote part of a message | Closed: "Quote" on a selection in both; it puts the quoted line in the box | `gap-4-quote-selection.png`, `gap-4-quote-bar.png` |
| 5 | Pin a message | Closed: "Pin" in the menu and "Pinned messages: 1" in both | `gap-5-pin.png` |
| 6 | Copy a link to a message | Closed: "Copy link" in both menus | `gap-6-copy-link-menu.png` |
| 7 | "Enter to send" hint | Closed: the room shows the hint and its own "@agent" line | `gap-7-enter-hint.png` |
| 8 | Phone header | Improved: two rows (name; people and agents), nothing cut. The Fleet's is one row | `gap-8-phone-header.png` |
| 9 | Full width | Closed: in the room's menu | `gap-9-full-width-menu.png` |

Two small differences seen on this walk and not listed before: a picture waiting in the box shows its thumbnail in
the Fleet chat and a plain file icon in the room (`gap-1-paste-screenshot.png`); and the room's search has no
Filters (above).

## 5. Proposed cards

| Card | What | Size |
|---|---|---|
| P1 (M-3308, in progress) | Paste a screenshot and drop a file into a room, as in the Fleet chat | S |
| P2 | Long paste becomes a text-file chip, with the same notice | S–M |
| P3 | Quote selected text | S–M |
| P4 | Copy link to a message; "Full width"; the Enter hint | S |
| P5 | Phone header in one row | S |
| P6 | Pins in a room: decide personal or shared, then build | M |
| P7 | Finish the unverified items: Fleet search, files and viewer side by side, buttons and polls, link previews | S (a walk, not a build) |

## 6. 給擁有者的摘要（zh-TW）

實際用無頭瀏覽器在開發中版本（c891e8d41）各操作一遍，不是只看程式碼。

**Hub 房間少了、Fleet 聊天有的（依常用程度排序）：**
1. 貼上截圖（Ctrl+V）：Fleet 會出現檔案標籤，Hub 沒有反應。（已是 M-3308）
2. 把檔案拖進對話：同上，Hub 沒有反應。
3. 貼上很長的文字：Fleet 會自動變成文字檔標籤並提示，Hub 不會。
4. 選取一段文字後「引用」：Fleet 有，Hub 只能回覆整則。
5. 釘選訊息：Fleet 有，Hub 沒有。（要先決定房間裡的釘選是個人的還是大家共用）
6. 複製訊息連結：Fleet 有，Hub 沒有。
7. 輸入框下方的「Enter 送出 · Shift+Enter 換行」提示：Hub 被 @Agent 的說明取代了。
8. 手機版標題列：Fleet 一行；Hub 三行，房間名稱貼著上緣、人數被截斷。
9. 「全寬」：Fleet 選單有，Hub 沒有。

**刻意不同、不算缺口的：** 斜線指令（控制單一 Agent 的工作階段，房間不適用）、@ 選單（房間才有）、模型選擇、成員面板、每個人都能加表情回應（房間才有）、通知鈴鐺放在房間標題。

**兩邊一樣（已確認）：** 附加檔案、Enter／Shift+Enter／輸入法選字時不送出、回覆、複製、粗體／清單／表格／程式碼區塊、往上捲載入舊訊息與「最新」按鈕、文字大小、Ctrl K 搜尋。

**這次沒能確認的：** Fleet 的搜尋結果、Fleet 傳出圖片與 HTML 檔後的顯示、按鈕與投票、連結預覽，以及真實剪貼簿／拖曳／輸入法（我是用瀏覽器事件模擬的）。原因是測試用的 Fleet 沒有真的 Agent 在跑。這幾項我沒有算成缺口，也沒有算成通過。

**建議的卡片：** P1 貼圖與拖曳（M-3308）→ P2 長文字變檔案 → P3 選取引用 → P4 複製連結、全寬、Enter 提示 → P5 手機標題列 → P6 釘選（先決定規則）→ P7 把沒確認的項目補走一遍。
