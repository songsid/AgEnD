# S-118 implementation evidence

Actual signin.html shell in Chromium 156.0.8078.4. Eight EN/zh × desk1366/phone390 × light/dark cases. Originals are committed PNGs, not build artifacts.

**HOLD:** Junsion’s code-only core must land before this PR can be reviewed/merged. These captures and the real success check exercise the existing web-only route only; chat and double-match are NOT RUN. The server’s authentication core is unchanged.

514/514 tests across24 related suites; both typechecks;329 fragments; six independent intended mutation failures followed by restored green. The first UI fail-first run was34red/6controls; the temporary-entry test also failed only its old-page control before replacement. Browser:141 checks,56 PNGs; hint/help/disabled text≥4.5:1, visible controls≥44px, no horizontal overflow.

Before/SKEW route exact base d8dd79910a643f9546cd07045015208aafb42ed6 UI assets into the scratch listener. This is not a separate base-daemon rehearsal. Current source hashes and every PNG hash are pinned in receipt.json/PRODUCTION_SHA256SUMS/SHA256SUMS. All listeners and scratch state are closed/removed by the driver.

SKEW: old JS+new HTML and new JS+old HTML each successfully redeem a real synthetic device sign-in code in every case. Old HTML retains centered placement and lacks the nowrap class; the phone zh subtitle may split 自動登入. No raw translation keys or broken form, no JS/CSP errors. Existing old-page wording remains a cached-copy limit.

| Case | Before | Current | Wrong | Paused | Reach help | Old JS | Old HTML |
|---|---|---|---|---|---|---|---|
|desk-light-en|[PNG](desk-light-en-before-primary.png)|[PNG](desk-light-en-after-primary-view.png)|[PNG](desk-light-en-after-wrong-view.png)|[PNG](desk-light-en-after-paused-view.png)|[PNG](desk-light-en-after-reach-view.png)|[PNG](desk-light-en-skew-old-js-primary.png)|[PNG](desk-light-en-skew-old-html-primary.png)|
|desk-light-zh-TW|[PNG](desk-light-zh-TW-before-primary.png)|[PNG](desk-light-zh-TW-after-primary-view.png)|[PNG](desk-light-zh-TW-after-wrong-view.png)|[PNG](desk-light-zh-TW-after-paused-view.png)|[PNG](desk-light-zh-TW-after-reach-view.png)|[PNG](desk-light-zh-TW-skew-old-js-primary.png)|[PNG](desk-light-zh-TW-skew-old-html-primary.png)|
|desk-dark-en|[PNG](desk-dark-en-before-primary.png)|[PNG](desk-dark-en-after-primary-view.png)|[PNG](desk-dark-en-after-wrong-view.png)|[PNG](desk-dark-en-after-paused-view.png)|[PNG](desk-dark-en-after-reach-view.png)|[PNG](desk-dark-en-skew-old-js-primary.png)|[PNG](desk-dark-en-skew-old-html-primary.png)|
|desk-dark-zh-TW|[PNG](desk-dark-zh-TW-before-primary.png)|[PNG](desk-dark-zh-TW-after-primary-view.png)|[PNG](desk-dark-zh-TW-after-wrong-view.png)|[PNG](desk-dark-zh-TW-after-paused-view.png)|[PNG](desk-dark-zh-TW-after-reach-view.png)|[PNG](desk-dark-zh-TW-skew-old-js-primary.png)|[PNG](desk-dark-zh-TW-skew-old-html-primary.png)|
|phone-light-en|[PNG](phone-light-en-before-primary.png)|[PNG](phone-light-en-after-primary-view.png)|[PNG](phone-light-en-after-wrong-view.png)|[PNG](phone-light-en-after-paused-view.png)|[PNG](phone-light-en-after-reach-view.png)|[PNG](phone-light-en-skew-old-js-primary.png)|[PNG](phone-light-en-skew-old-html-primary.png)|
|phone-light-zh-TW|[PNG](phone-light-zh-TW-before-primary.png)|[PNG](phone-light-zh-TW-after-primary-view.png)|[PNG](phone-light-zh-TW-after-wrong-view.png)|[PNG](phone-light-zh-TW-after-paused-view.png)|[PNG](phone-light-zh-TW-after-reach-view.png)|[PNG](phone-light-zh-TW-skew-old-js-primary.png)|[PNG](phone-light-zh-TW-skew-old-html-primary.png)|
|phone-dark-en|[PNG](phone-dark-en-before-primary.png)|[PNG](phone-dark-en-after-primary-view.png)|[PNG](phone-dark-en-after-wrong-view.png)|[PNG](phone-dark-en-after-paused-view.png)|[PNG](phone-dark-en-after-reach-view.png)|[PNG](phone-dark-en-skew-old-js-primary.png)|[PNG](phone-dark-en-skew-old-html-primary.png)|
|phone-dark-zh-TW|[PNG](phone-dark-zh-TW-before-primary.png)|[PNG](phone-dark-zh-TW-after-primary-view.png)|[PNG](phone-dark-zh-TW-after-wrong-view.png)|[PNG](phone-dark-zh-TW-after-paused-view.png)|[PNG](phone-dark-zh-TW-after-reach-view.png)|[PNG](phone-dark-zh-TW-skew-old-js-primary.png)|[PNG](phone-dark-zh-TW-skew-old-html-primary.png)|

Run:

```sh
REPO="$PWD" PW_DIR="$PWD/node_modules/playwright-core" CHROME=/path/to/chrome \
  FONTCONFIG_FILE=/path/to/fonts.conf OUT="$PWD/.artifacts/s118/browser" MATRIX=full \
  systemd-run --user --scope -q -p MemoryMax=3G -- \
  npx tsx scripts/manual/smoke/smoke-signin-unified-s118.mts
```

Mutation scopes (one at a time): remove the800ms branch; auto dedupe; keydown cancellation; post-fetch current fence; post-body current fence; broaden six-digit raw validation. Each caused intended assertion failures in signin-unified-s118.test.ts; production restored before final tests/capture.

No independent real-account, chat-code-only, double-match, public-link or native-platform acceptance is claimed. The former Devices overview/QR proposal and Settings sign-in-name line are out of scope.

Required scan initially flagged two public source digests as generic API keys. Current evidence uses digest-first PRODUCTION_SHA256SUMS. Only the two exact historical commit/path/rule/line fingerprints are recorded in .gitleaksignore; no rule/path/future finding is exempted. Product source and PNG bytes are unchanged by this correction.
