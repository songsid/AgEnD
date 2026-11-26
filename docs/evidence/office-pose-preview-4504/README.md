# Preview a character's poses from their card (#4504)

These are captures of the real Office UI, taken in headless Chromium with the smoke fixture. The pack is synthetic and self-drawn, and the agents are fixture agents Alpha to Echo, in one office, HQ. No real names.

- **At:** `10bc372a` (the feature commit; the commit that adds this folder changes nothing else under `src/`).
- **Script:** `capture.mts`. Copy it to `scripts/manual/smoke/` and run it with `REPO=<checkout> PW_DIR=<checkout> OUT=<dir> DEV=desk|phone` (and `PW_DPR=3` for the phone), using the same Playwright image the ui-gate smokes use.
- Desk: 1366×900 at DPR 1. Phone: 390×844 at DPR 3. Every case was captured (desk and phone × light and dark × EN and zh-TW); four are kept here, covering each of the six: `desk-light-en`, `desk-dark-zh-TW`, `phone-light-zh-TW`, `phone-dark-en`.
- Before each capture the picker is scrolled to the middle of the card, so it is in view (on a phone the sheet scrolls).

No run had page errors or CSP violations. In every case the picker's label read "Preview pose" / "預覽動作", its options were Off / 關閉 then the twelve poses, and Replay was enabled once a pose was picked.

## The pack

1280×720, four rooms (Work, Lounge, Help desk, Nap). Each strip is drawn to be told apart at a glance: idle (blue, facing front), working (with a laptop), walkSide (in profile), walkUp (the back of the head), pat (pink, with hearts), needs (red, with a yellow "!"). Everyone is idle in the Lounge; Alpha's card is open (Alpha stays put while carded, #4466).

| File (`<device>-<theme>-<lang>-…`) | What it shows |
|---|---|
| `1-card-picker-off.png` | Alpha's card: **Preview pose** set to Off, **Replay** disabled. Alpha is drawn in their own idle pose. |
| `2-walkUp.png` | walkUp picked: Alpha walks on the spot with their back to us (the back of the head). |
| `3-pat.png` | pat picked: Alpha is pink with hearts. The others are unchanged (the preview is that person's only). |
| `4-replay.png` | Just after Replay: the pat strip starts again from its first frame. |
| `5-caller-with-preview-on.png` | With a preview still on (idle), Alpha's status is set to `crashed`. 12 s later Alpha is at the Help desk drawn calling (red, "!", the call bubble), not in the previewed pose; the card shows "Crashed" / "已當掉". |
