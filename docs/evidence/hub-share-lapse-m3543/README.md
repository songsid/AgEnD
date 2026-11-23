# M-3543: a lapsed Hub share

**Hub side** (`scripts/manual/hub-share-lapse-m3543/hub-browser.mts`):
- the owned Hub over HTTPS and SQLite, with the shipped UI;
- the member side is synthetic frames: the catalog with the lapse, the republish result, the next snapshot;
- one colleague holds a direct grant for Mira.

**Fleet side** (`fleet-settings.mts`):
- the real dashboard on the smoke fixture;
- the member's two reads (membership/pairing, exposures) are answered with fixture data.

| Picture | What it shows |
|---|---|
| `before-*-lapsed.png` (dev, without the change) | Mira looks shared ("1 person may ask"). Nothing says the share stopped working: the desk picture is byte-identical to `after-desk-en-shared-again.png`, because the old page cannot tell a lapsed share from a working one. |
| `after-*-lapsed.png` | "Needs re-share …" with **Share again** (zh-TW 需要重新分享… / 重新分享). |
| `after-desk-en-shared-again.png` | After Share again, the Fleet republishes at revision 2. The note is gone and the colleague's grant was carried over: still "1 person may ask". |
| `fleet-settings-*.png` | Fleet Settings → Hub: the lapsed row's note and **Share again**. |
