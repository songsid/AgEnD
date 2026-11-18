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

## 4. Not verified

| Item | Why | What would settle it |
|---|---|---|
| Fleet search results | Search stayed "off" in the scratch Fleet | A scratch Fleet with search working, or a look on a running one |
| A sent image or HTML file on the Fleet side (inline picture, viewer, HTML preview) | The scratch Fleet cannot deliver a message | The same |
| The same on the Hub side | Checked: a picture shows inline and opens a viewer (zoom, fit, Annotate, Open original); an HTML file shows as a card and opening it showed no preview | Compare once the Fleet side is seen |
| Buttons and polls | I could not stage an agent's buttons in either product | The repo has its own browser walks for each; I did not rerun them |
| Link previews | Neither product drew a preview card for the link in my answer; I do not know when the Fleet draws one | Ask the builder |
| Real clipboard, real drag, real input method | Sent as browser events | One manual pass on a real browser |

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
