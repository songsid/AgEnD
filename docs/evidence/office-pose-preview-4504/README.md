# Preview a character's poses from their card (#4504)

These are captures of the real Office UI, taken in headless Chromium with the smoke fixture. The pack is synthetic and self-drawn, and the agents are fixture agents Alpha to Echo, in one office, HQ. No real names.

- **At:** `d271fe29` (Replay as a small button on the picker's row). The commit that refreshes this folder changes nothing else under `src/`.
- **Script:** `capture.mts`. Copy it to `scripts/manual/smoke/` and run it with `REPO=<checkout> PW_DIR=<checkout> OUT=<dir> DEV=desk|phone` (and `PW_DPR=3` for the phone), using the same Playwright image the ui-gate smokes use.
- Desk: 1366×900 at DPR 1. Phone: 390×844 at DPR 3. Every case was captured (desk and phone × light and dark × EN and zh-TW); four are kept here, covering each of the six: `desk-light-en`, `desk-dark-zh-TW`, `phone-light-zh-TW`, `phone-dark-en`.
- Before each capture the picker is scrolled to the middle of the card, so it is in view (on a phone the sheet scrolls).

No run had page errors or CSP violations. In every case the picker's label read "Preview pose" / "預覽動作", its options were Off / 關閉 then the twelve poses, each named with its strip key ("Idle (idle)", 「閒置（idle）」 …), and Replay was enabled once a pose was picked.

Measured in the page (CSS px, `report-<device>.json` of the run): on the phone sheet the select and Replay are **44** tall, like the actions row (44), and the select's font is 16 px; on a desk they are 20 and 30, as the desk card's other controls (30). In all eight cases, EN and zh-TW, Replay sits on the picker's row (`sameRow`: their centres within 4 px).

## The pack

1280×720, four rooms (Work, Lounge, Help desk, Nap). Each strip is drawn to be told apart at a glance: idle (blue, facing front), working (with a laptop), walkSide (in profile), walkUp (the back of the head), pat (pink, four frames: frame *k* has *k* + 1 hearts, so a restart shows), needs (red, with a yellow "!"). The Help desk is the standard `alert` area, so its name is translated (求救區). Everyone is idle in the Lounge; Alpha's card is open (Alpha stays put while carded, #4466).

| File (`<device>-<theme>-<lang>-…`) | What it shows |
|---|---|
| `1-card-picker-off.png` | Alpha's card: **Preview pose** set to Off, **Replay** disabled. Alpha is drawn in their own idle pose. |
| `2-walkUp.png` | walkUp picked: Alpha walks on the spot with their back to us (the back of the head). |
| `3-pat.png` | pat picked, 1.2 s in: Alpha is pink with three hearts (frame 2). The others are unchanged (the preview is that person's only). |
| `4a-replay-restarts.png` | Just after Replay: one heart, the strip back at its first frame. Replay is a small bordered button on the picker's row. |
| `4b-replay-plays-on.png` | 1.1 s later: three hearts again, playing on. |
| `5a-previewed-agent-calls.png` | With **pat still picked** (the picker shows it), Alpha's own status is set to `crashed`. The preview gives way: 1.5 s after the page shows the call, Alpha is walking to the Help desk, not in the pat pose, and the card says "Calling for you" / 「在呼叫你」. |
| `5b-previewed-agent-at-help-desk.png` | 10.5 s later: Alpha at the Help desk drawn calling (red, "!", the call bubble), the card reading "HQ · Help desk" / 「HQ · 求救區」 and "Crashed" / 「已當掉」, the picker still on pat. |
