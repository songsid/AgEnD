# M-3604: @agent in a Hub one-to-one, and what a refused send says

Real Hub (HTTPS + SQLite, the s3b rig) and the real Hub web UI, driven headlessly. No Fleet, CLI or model, so a sent question stays queued. Fixture names only.

Each run signs in as the asker, opens a fresh one-to-one with **Desk**, sends 「嗨」/"Hi", then 「@Desk 哪一份週報是我的？」/"@Desk which weekly report is mine?".

| File | What it shows |
|---|---|
| `*-before-1-mention.png` | release/2.3.5-alpha acf22f6d: the @Desk message stays in the box with 「沒有送出：沒有送到 AgEnD，請檢查網路連線」/"Not sent: it did not reach AgEnD — check the connection". The Hub had refused it with 400 `invalid`. |
| `*-after-1-mention.png` | This PR: the @Desk message is sent as written, with no error. |
| `*-after-2-refused-busy.png` | This PR: a third message refused by the Hub with 429 `backpressure` (forced in the browser) says 「沒有送出：Hub 目前忙碌，請稍候再試」/"Not sent: the Hub is busy just now — try again in a moment", with Retry. |

Variants: desk zh-TW light, phone zh-TW dark, desk en dark, phone en light. In the desk en captures, the sidebar also lists the earlier runs' Desk chats from the same rig Hub.

The script is `cap3604.mts` (session scratch; not committed). Run it with `REPO=<checkout> LABEL=before|after`.
