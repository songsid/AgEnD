# M-3742: the preview's "I understand", the preview frame's edge, 優先級 and 「Agent」 (real app)

These are the items from Prism's #4462 triage that reproduce on the real app:

- **"I understand"** (`.pv-banner .pv-ack`) appears on the HTML preview notice in the chat, the preview panel and a task card's files.
  - Before, it was a ghost button: 30 px tall, with no edge and no background, so it read as text.
  - Now it is a flat button: the page's background, a `--border-strong` edge and no shadow. On a phone it is a 44 px box.
- **The preview frame's edge** (`.preview-frame`):
  - Before, it was `--warn-line`: 1.95:1 on white and 2.78:1 on dark (measured with its alpha laid over the page).
  - Now it is `--warn` mixed 85% into `--bg`: 4.29:1 in light and 6.36:1 in dark. `tests/shared-ui-polish-m3742.test.ts` computes it against `--bg` and `--surface` in every palette, light and dark, and finds every one at least 3:1.
- **zh-TW:**
  - 優先度 → 優先級 across the task board (11 strings).
  - The preview strings now say 「Agent」.

Not changed, because Prism withdrew both:
- The task card's Back and Previous / Next are already 44 px on a phone (`.tp-bar` override).
- The ring around the heading after a card opens is its focus target (`.tc-head[tabindex=-1]`).

The capture keeps both as regression checks. They pass before and after.

**Captures.** From the real web app (`scripts/manual/smoke-fixture`), headless Chromium: a made-up project whose developer card has a one-file HTML prototype attached, opened and previewed. The same script, `scripts/manual/shared-ui-polish-m3742/capture.mts`, ran on each checkout:
- `before/`: release `b4eb60a7a`, 20 of 48 checks. "I understand" fails as a flat button and as a 44 px box on a phone, the frame's edge is under 3:1, and zh shows 優先度 and a lowercase agent.
- `after/`: this branch at `34c18407c` (`src` the same as `458831455`), 48 of 48.

Each `receipt.json` lists the commit (its `src` clean), every check, the measured button, frame and tap boxes, and each PNG's sha256.

| What | Files (in `before/` and `after/`) |
|---|---|
| The card (priority label, Back and Previous / Next, the title at rest) | `m3742-{desk,phone}-{light,dark}-{en,zh-TW}-1-card.png` |
| The running preview: the notice with "I understand", and the frame | `m3742-{desk,phone}-{light,dark}-{en,zh-TW}-2-preview.png` |
