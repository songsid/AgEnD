# M-3770 S-241: the update card's follow-ups (Lumen's points 3 and 8)

Real-app captures from the owned web fixture (`scripts/manual/smoke-fixture`) in headless Chromium, driven through the real server objects (the update card and its answer route). Nothing installs: every launch path is stubbed before the first press.

Script: `scripts/manual/update-followups-s241/capture.mts`. It ran at `1fbbd95da` (`src` clean) and passed 53 of 53 checks. `receipt.json` lists every check, each PNG's sha256 and the banner's height in each state.

## Point 8: an answered banner is one line on a phone

Once the admin has answered (Update when idle, or a picked time), a phone shows the banner as one line: the short words and **Change**. Change opens the full line, with its words, who it waits for and the buttons. A new state starts closed. The desk is unchanged.

| Frame | What it shows |
|---|---|
| phone 1-waiting | "AgEnD updates when idle" / 「AgEnD 閒置時更新」 and Change. The banner is 65 px high (10 px padding, one 44 px button, the border); it was 131 px (en) / 112 px (zh-TW). |
| phone 1b-waiting-open | After Change: "Updating to X as soon as your agents are idle.", who it waits for, and Update now, Pick a time, Cancel and Close (in English the four buttons take two rows; every one is wholly on the screen). Opening it decides nothing. |
| phone 2-scheduled | After Cancel and then Pick a time → Tonight: "AgEnD updates Thu 22:00" / 「AgEnD 週四 22:00 更新」 (weekday and 24-hour time), closed again. 65 px. |
| phone 2b-scheduled-open | After Change: the full time, with Update now, Cancel and Close. |
| desk 1-waiting, 2-scheduled | As before: the full words and the buttons. There are no short words and no Change. |

The matrix is desk light en, desk dark zh-TW, phone light en and phone dark zh-TW. The phone checks cover the title on one unclipped line, 44 px buttons wholly on the screen, and no sideways scroll.

## Point 3: General's chat card says what the web card says

`chat-transcript.md` (with `chat-receipt.json`, 14 of 14 checks, at the same commit) is #4485's transcript script rerun on this branch. It shows the chat card's way-back sentence as "Your work continues; if the new version won't start, AgEnD tries to roll back to X.", word for word as the web card. zh-TW's scheduled line now matches the web's too: 「排定在 {time}，等 Agent 閒置後更新到 {version}。」 `tests/update-followups-s241.test.ts` compares the two cards' sentences in both languages.
