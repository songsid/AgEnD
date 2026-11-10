# S-118 implementation evidence

Actual signin.html shell in Chromium 156.0.8078.4. Eight EN/zh × desk1366/phone390 × light/dark cases. Originals are committed PNGs, not build artifacts.

#3563 is merged as4eb8d787; this branch plain-merged alpha9458db49 at19bd54f06. The only auth-api conflict was the temporary GET page: both entry URLs now use the unified shell and retain the availability/method fences. POST routes, matching, sessions, policy, storage and limiters exactly retain upstream.

Fresh validation:870/870 across29 related suites, both typechecks,331 fragments. All nine independent controller mutations are caught; the active controller source is unchanged. R1 adds no-AbortController A→B→A late200/401, unavailable404 and IME-event cases, and removes the retired temporary HTML/JS/public asset (whose404 was first red). Web-only Chromium156 layout/SKEW:149checks/56PNGs; shared Settings style gate114checks. Chat acceptance adds74checks/17PNGs, for73 committed original PNGs in total. See [chat-validation.json](chat-validation.json), [style-validation.json](style-validation.json) and digest-first manifests.

Real Chrome on the scratch production listener, EN/zh × desktop/phone × light/dark: two distinct synthetic secrets are searched for an actual current-step HMAC collision, with both server and browser clocks real. Ordinary wrong and collision each return401 and show identical text; collision creates no session, spends neither step and sends no notice. The next unique accepted-step code signs in as the correct synthetic chat admin; only `{code}` is sent. HTTP body equality is additionally checked on the same real route. The real browser's fifth wrong attempt shows429 and a wait. No separate collision state or account inference exists.

The public-link policy leg binds production gateway metadata on a second owned HTTP ingress; it checks chat200, loopback-only404, retired-context403 before body/counters, demoted admin401 and cross-Origin403. It is not an actual tunnel or public gateway run. No platform adapter, fleet start, CLI, model, real account or live host operation.

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

Mutation scopes (one at a time): remove the800ms branch; auto dedupe; keydown cancellation; post-fetch current fence; post-body current fence; broaden six-digit raw validation; remove generation/object fencing without AbortController; drop the authenticator404 branch; drop IME input fencing. Each caused intended assertion failures in signin-unified-s118.test.ts; production restored before final tests/capture.

No real-account, actual tunnel/public-gateway, platform-adapter or native-platform acceptance is claimed. The former Devices overview/QR proposal and Settings sign-in-name line are out of scope.

Required scan initially flagged two public source digests as generic API keys. Current evidence uses digest-first PRODUCTION_SHA256SUMS. Only the two exact historical commit/path/rule/line fingerprints are recorded in .gitleaksignore; no rule/path/future finding is exempted. Product source and PNG bytes are unchanged by this correction.

Shared smoke bootstrap: input+requestSubmit happen in one browser task, then the original dashboard navigation is required. This supports current auto-submit and cached manual-only scripts. The earlier dedicated four-case bootstrap proof is retained in fixture-validation.json; the final merged-core Settings gate passes114checks with assertions/timeouts unchanged.

The original controller fail-first run produced34 semantic failures and6 passing controls. Nine isolated source reversals fail intended assertions; the restored controller is byte-identical for this merged-core continuation. At390px each error/recovery paragraph fits at most two lines, and the fallback helper stays on one line. Contrast and44px controls are checked on the current page.

Earlier CI copy regressions were corrected without weakening /web recovery or the one-home byte comparison beyond the authorized8碼→8字元 glossary change. Current exact-head CI/scan and parity review remain required.

Chat originals (each case has ordinary wrong and collision):

| Case | Wrong | Actual collision |
|---|---|---|
|desk-light-en|[PNG](desk-light-en-chat-wrong-view.png)|[PNG](desk-light-en-chat-collision-view.png)|
|desk-light-zh-TW|[PNG](desk-light-zh-TW-chat-wrong-view.png)|[PNG](desk-light-zh-TW-chat-collision-view.png)|
|desk-dark-en|[PNG](desk-dark-en-chat-wrong-view.png)|[PNG](desk-dark-en-chat-collision-view.png)|
|desk-dark-zh-TW|[PNG](desk-dark-zh-TW-chat-wrong-view.png)|[PNG](desk-dark-zh-TW-chat-collision-view.png)|
|phone-light-en|[PNG](phone-light-en-chat-wrong-view.png)|[PNG](phone-light-en-chat-collision-view.png)|
|phone-light-zh-TW|[PNG](phone-light-zh-TW-chat-wrong-view.png)|[PNG](phone-light-zh-TW-chat-collision-view.png)|
|phone-dark-en|[PNG](phone-dark-en-chat-wrong-view.png)|[PNG](phone-dark-en-chat-collision-view.png)|
|phone-dark-zh-TW|[PNG](phone-dark-zh-TW-chat-wrong-view.png)|[PNG](phone-dark-zh-TW-chat-collision-view.png)|

[Chat browser pause](chat-en-browser-paused-view.png).

```sh
REPO="$PWD" PW_DIR="$PWD/node_modules/playwright-core" CHROME=/path/to/chrome \
  FONTCONFIG_FILE=/path/to/fonts.conf OUT="$PWD/.artifacts/s118/chat" MATRIX=full \
  systemd-run --user --scope -q -p MemoryMax=3G -- \
  npx tsx scripts/manual/smoke/smoke-signin-chat-s118.mts
```

R1 cleanup keeps both /signin entry URLs and their method/availability checks. The retired temporary HTML, JS and public asset entry are removed. The two old core-file UI assertions now inspect the actual unified page; all110 core tests remain, including every auth policy/matching/limiter/session assertion. New captures repeat149+74checks; the114-check Settings style result carries on unchanged layout/CSS.
