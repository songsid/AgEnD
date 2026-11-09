# One Hub connection card — S-119 Story 4

Settings → Hub combines company sign-in, saved status, pause/resume and the existing Agent share selector in one card. Pairing-code controls and the old membership switch remain under Advanced. This implements the approved [M-2722 proposal](https://github.com/songsid/AgEnD/tree/7b5c11568c8f8b0a1c08a7289ba3186b4d5fb08d/docs/screenshots/hub-connection-card-m2722), with [#3491](https://github.com/songsid/AgEnD/pull/3491)'s exact handoff discovery and [#3487](https://github.com/songsid/AgEnD/pull/3487)'s shared confirmation controls retained. Story 5's Hub admin ordering is a separate delivery.

The shared components are `.card`, `.s-group`, `.field`, `.grid2`, `.s-ui-disclosure`, `.btn`, `.tag`, `Skeleton`, `ErrorState` and the existing `PendingChanges` card. The existing company/manual pairing and exposure components accept embedded rendering; their request and consent paths remain in charge. The main flow adds no clicks. A non-host owner reviews the same exact pending request in the Settings column; host-owned Start still uses its existing folded approval.

## Evidence

- `before/`: a32b177df, eight desktop/phone × EN/zh-TW × light/dark cases, **58 checks**. Actual company connection, explicit share and pause/reload, on the real earlier UI.
- `after/`: same matrix, **102 checks**. Actual company sign-in, pinned member transport ready, explicit share, pause/reload with retained profile, resume with retained selection. No Agent is shared on connection. Phone taps and overflow measured; final phone shots are scrolled to the connection card and sharing controls.
- `pending/`: two real non-host Settings journeys, **17 checks**, including exact Review/Withdraw, browser wait timeout and unchanged server authorization. No Hub enrollment is created by the pending or withdrawn request.
- `style/`: Settings UI gate, `GATE=full SECTIONS=hub`, **62 checks**, including opened disclosures, long-value pass and 900/1024/1180/1280 widths. The gate drew the new form. Image review checked desktop/phone connected, unconnected and paused layouts.
- `skew/`: five retained combinations, two viewports each, **30 checks**: old section, membership, company or manual module against the new host, and current modules against the earlier host. Actual retained JS blobs, no API answer substitution. Every combination keeps the complete earlier UI and performs no unsolicited write.
- `mutations.json`: **15/15** independent source reversals caused collected assertion failures; originals restored. This includes owner/config/path/membership fences, passive-read Stop/config fences, projection mark, offline status, late read, single write, public read, exact pending review and retired-join state.
- `fail-first.json`: realistic copied raw config exposed the original reference-comparison failure; the final read compares mounted config/path and membership values.
- `checks.json` records focused tests and types. `manifest.json` is digest-first; its keys are file digests, and its values are paths.

The browser rig uses actual Fleet HTTP, cookies, CSRF, Settings replay, a sealed Hub HTTPS/WSS listener and the production AD driver against an owned recorded LDAPS peer. Synthetic people and an inert configured Agent only. Backend and browser connections stay on the owned listeners. Native/model/CLI entry points refuse; no question is sent to an Agent. No real directory, account, pilot, host service or live Fleet is used. Receipts record cleanup.

The small new GET projection reads private saved pairing files while paused; it never writes or activates membership. Its old no-query response stays unchanged. The stored profile has no Fleet display label, so the summary says “This Fleet” rather than inventing a cached label. Exact revoke remains in the existing running-member settings; a paused connection resumes before using that existing API. Pause retains conversations and the saved binding, not a promise to recover messages already sent elsewhere.

## Reproduce

Use your own checkout, private Playwright/Chromium install and CJK font configuration. Choose two free adjacent fixture ports. No credentials are required.

```sh
REPO="$PWD" PW_DIR=<owned-playwright-node_modules> CHROME=<owned-chromium> FONTCONFIG_FILE=<owned-fontconfig> OUT=<owned-output> MATRIX=full node --import tsx scripts/manual/hub-connection-card/accept.mts
REPO="$PWD" PW_DIR=<owned-playwright-node_modules> CHROME=<owned-chromium> FONTCONFIG_FILE=<owned-fontconfig> OUT=<owned-output> MATRIX=quick node --import tsx scripts/manual/hub-connection-card/pending.mts
REPO="$PWD" PW_DIR=<owned-playwright-node_modules> CHROME=<owned-chromium> FONTCONFIG_FILE=<owned-fontconfig> OUT=<owned-output> MATRIX=quick SKEW=old-company node --import tsx scripts/manual/hub-connection-card/accept.mts
node scripts/manual/hub-connection-card/verify.mjs
```

Run reversals alone, without other tests or browsers reading the same source. The earlier-host case points `REPO` at an owned a32b177df checkout and `CANDIDATE` at this checkout, with `SKEW=old-server`. `BEFORE=1` renders the earlier UI against its own source. The scripts only replace retained static modules for SKEW; they never replace API responses.

Rollback removes this layout and additive read. The existing boolean, pairing profiles and exposure records keep their original meaning; no data migration is added.
