# #3727 (M-2973): annotate a chat image and quote it to the agent — browser evidence

From `scripts/manual/smoke/smoke-chat-annotate-3727.mts` with `MATRIX=full`. It runs real headless Chrome on the shared smoke fixture: the product's own web server in a scratch HOME, guard binaries, an IPC stub agent (no CLI, tmux or account), no fleet start, loopback only. Phone drawing uses CDP touch events.

**122/122 checks** (`result.json`).

## Source pins

| Side | What is served |
|---|---|
| **current/** and **legs/** | This PR's head: every file as committed. |
| **before/** | The same server (this PR's head), with these five browser files replaced by their copies at `release/2.3.5-alpha` **05c31c27** (the alpha tip when the run was made): `image-lightbox.js`, `panel-chat.js`, `chat-workspace.js`, `app.css`, `tokens.css`. The viewer has no 「標註」 there, and the reply bar's label does not shorten. |

## before/ — 8 cells (desk/phone × light/dark × en/zh-TW)

- `<cell>-1-viewer.png`: the image viewer before the feature (Open original only).
- `<cell>-2-reply.png`: the reply bar to the image message, before the label fix. On a phone in English, the ✕ is pushed off-screen by the long sender name.

## current/ — the same 8 cells

- `<cell>-1-viewer.png`: the viewer with **Annotate / 「標註」** (an icon on a phone).
- `<cell>-2-editor.png`: the editor with tools, four colours (44 px targets on touch), undo/redo/Clear, ✕, and **Quote to agent / 「引用給 Agent」**.
- `<cell>-3-marked.png`: a pen stroke, a box, a blue arrow and text. On a phone, marks are sized for the screen they are drawn on.
- `<cell>-4-composer.png`: after the quote, one `screen-annotated.png` attachment and the reply bar, with ✕ on screen.

## legs/

- `split-1-editor.png`, `split-2-other-pane.png`: split chat. **Quote to *B*** puts the PNG and a single quote line in the other pane.
- `skew-missing-editor.png`: the editor module is missing (404). A notice shows, and the viewer works.
- `skew-old-tokens-editor.png`: this editor with the old `tokens.css`, which has no `--media-*` or `--mark-*`. The swatches show four distinct colours, and the selected tool and the bar are visible.

## What the run checks besides the pictures

Per cell:
- Send uploads a PNG of the canvas size.
- `/ui/send` carries one attachment and `replyTo` set to the original message.
- The IPC delivery carries the text.
- The original file's sha256 is unchanged on disk and as served.
- Esc adds nothing.
- An export still encoding when the editor closes (Esc, then ✕) adds nothing.
- No page errors and no CSP reports.

On a phone, every editor control measures at least 44 × 44. The SKEW legs also run the previous viewer (no button; it works).
