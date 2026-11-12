# #3727 (M-2973): annotate a chat image and quote it to the agent — browser evidence

From `scripts/manual/smoke/smoke-chat-annotate-3727.mts` with `MATRIX=full`: real headless Chrome on the shared smoke fixture. It uses the product's own web server in a scratch home, an IPC stub agent, no fleet start, and loopback only. **93/93 checks** passed (`result.json`) across desk/phone × light/dark × en/zh-TW, plus the split-chat and SKEW legs.

| File | What it shows |
|---|---|
| desk-light-en-1-viewer.png | The image viewer with **Annotate** next to Open original |
| desk-light-en-2-editor.png | The editor: tools, four colours, undo/redo/Clear, ✕, and **Quote to agent** |
| desk-light-en-3-marked.png, desk-dark-zh-TW-3-marked.png | A pen stroke, a box, a blue arrow and text |
| desk-light-en-4-composer.png, desk-dark-zh-TW-4-composer.png | After the quote: one `screen-annotated.png` attachment and the reply bar to the original message |
| phone-dark-zh-TW-2/3/4, phone-light-en-3-marked.png | Phone: finger drawing (CDP touch events), the title and ✕ on one row, readable text, the composer |
| phone-dark-en-4-composer.png | The reply bar with a long sender name: ✕ stays on screen (the old rule put it at x = 401 on a 390-px phone) |
| split-1-editor.png, split-2-other-pane.png | Split chat: **Quote to *B*** puts the PNG and a single quote line in the other pane |
| skew-missing-editor.png | The editor module missing (404): a notice, and the viewer still works |

The smoke also checks, in every case:
- Send uploads a PNG of the canvas size.
- `/ui/send` carries one attachment and `replyTo` set to the original message.
- The agent's IPC delivery carries the text.
- The original file is byte-identical, both on disk and as served.
- Esc closes without adding anything.
- There are no page errors and no CSP reports.
- With the previous image-lightbox.js, the viewer shows no Annotate button and works as before.
