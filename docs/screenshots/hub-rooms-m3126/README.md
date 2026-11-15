# Hub rooms: older messages, quote jump, failed / blocked ticks (M-3126)

Drawn by `scripts/manual/hub-rooms/scroll-quote.mts` on an owned Hub HTTPS listener (`s3bRig`) with `createHubRoomsFixture()`. The weekly room is seeded with 80 older rows (`history 0` … `history 79`) plus a quote of `history 0`, a failed ask (`!` / expired) and a blocked ask (`⊘` / retired). Chromium 1248; desktop 1366×900 EN/light and phone 390×844 zh-TW/dark. No fleet, CLI, account or live Hub.

The latest page is 50 messages, so `history 0` is off that page until scroll-up (or a quote click) loads `before=`. TLS keys for the run stay in the process temp dir and are not in this folder.

| Shot | Desktop EN light | Phone zh-TW dark | What it shows |
| --- | --- | --- | --- |
| Bottom of the room | [ticks](ticks.desktop-en-light.png) | [ticks](ticks.phone-zh-TW-dark.png) | Empty quote chip on “about that first note” (original not in the latest 50). `!` on `@project-helper ping` with “The question expired before an answer” / 「問題在回答前就過期了」. `⊘` on `@report-bot later` with “This agent could not answer” / 「這個 Agent 無法回答」. |
| After scroll-up | [older](older.desktop-en-light.png) | [older](older.phone-zh-TW-dark.png) | Top of the thread: 陳主任 **history 0**. |
| Quote click | [jump](jump.desktop-en-light.png) | [jump](jump.phone-zh-TW-dark.png) | Same original, flashed (blue outline). |

## Reproduction

```sh
PW_DIR="$PWD/node_modules/playwright-core" \
CHROME=/home/han/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome \
REPO="$PWD" OUT="$PWD/docs/screenshots/hub-rooms-m3126" \
  npx tsx scripts/manual/hub-rooms/scroll-quote.mts
```

Six checks in `receipt.json` (ticks + oldest row + flash, both cases). Inspected: empty quote chip vs filled original; `!` / `⊘` and the reason line in both languages; history 0 at the top after paging; flash after the quote click.
