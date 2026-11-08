# #3402 startup campaign handoff

Standalone extraction from the executed #3395 recipe. The original merged fixture entry point is `scripts/manual/hub-quick-pairing/accept.mts` at f61e3608. Its peer is `tests/support/hub-group-directory-wire.ts`; invoke `groupWirePeer(certs.leaf, users)` with synthetic GroupWireUser records for **real dummy-password sign-in/eligibility**, not its older group-only mode. Production `createHubDirectory` retains TLS/BER/AD critical-control behavior; connector redirects only the explicitly configured loopback636 to the peer's owned ephemeral port.

Copy this script under `scripts/manual/hub-quick-pairing/` in **YOUR** checkout; its relative imports require that location. Do not execute the evidence copy in place or use Sentinel's filesystem paths. Set REPO to your target source (baseline or candidate) and use your own dependencies/browser. No app API replies are stubbed; no delays are injected. Browser route interception only refuses foreign origins (MODE=current, SKEW unset); leave those defaults for the startup campaign.

```sh
# From YOUR repository; obtain the pinned script using git show or its raw public URL.
mkdir -p .artifacts/my-3402/home .artifacts/my-3402/png .q3402
chmod 700 .q3402
# Preserve your own Node executable path before env -i.
probe_node=$(command -v node)
env -i PATH="$(dirname "$probe_node"):/usr/bin:/bin" \
  HOME="$PWD/.artifacts/my-3402/home" TMPDIR="$PWD/.q3402" \
  REPO="$PWD" ART="$PWD/.artifacts/my-3402" OUT="$PWD/.artifacts/my-3402/png" \
  PW_DIR="YOUR_NODE_MODULES_WITH_PLAYWRIGHT_CORE" CHROME="YOUR_CHROMIUM_EXECUTABLE" \
  FONTCONFIG_FILE="YOUR_FONTCONFIG_WITH_CJK_FONTS" MATRIX=full REPEATS=3 \
  REQUIRE_NO_429=1 "$probe_node" --import "$PWD/node_modules/tsx/dist/loader.mjs" \
  scripts/manual/hub-quick-pairing/startup-3402.mts
```

Choose a SHORT unique TMPDIR: a long path exceeds Chromium SingletonSocket's Unix-socket bound. CJK fonts must be visible under the scratch HOME/fontconfig; missing glyphs are a rig defect. All ports are acquired dynamically. No Docker, native CLI, model/account, daemon, host tmux, real directory or live fleet. The fleet web fixture supplies the Chromium engine only; no member activation or agent starts.

The admin configures both groups through preview/save UI, then its context closes. Each probe is one fresh `ungranted` login with all normal startup requests. Context close includes SSE/poll; the script waits for both eligibility wrapper and logical core counters to drain before the next case. Directory identities/groups are synthetic; no policy/grant/credential rows are seeded.

`startup-receipt.json` logs target Git SHA, case, actual HTTP status/Retry-After, attempted Core concurrency, admitted-before count, and real driver eligibility concurrency. **Baseline already enforces driverPeak=4. Therefore peak<=4 ALONE does not prove the fix.** The bug is attemptedPeak=5 plus429 and missing empty hint. After the fix, require no429 + visible ordinary empty hint in addition to the physical bound. REQUIRE_NO_429=1 exits1 on either failed condition; omit it for a collecting baseline run.

New extraction validation: frozen f61e3608, `MATRIX=quick REPEATS=1`, two independent pages (desktop/light/EN and phone/dark/zh). Both recorded attemptedPeak5 / driverPeak4, catalog429 / Retry-After10 and emptyHint=false. All close calls completed and driverActive=0. This validates the extraction; it is not a candidate-fix PASS or a new full-matrix claim. The old #3395 bundle contains full matrices and original three-page isolation proof.

This script does **not** deliberately occupy all slots to test a fixed UI's genuine busy recovery. Add that as a separate author control (hold authorized eligibility work while real HTTP requests pass through the server, then release), preserving ordinary requests and no fake API responses. Do not serialize the ordinary startup requests to hide the race. Do not reuse the full old pairing campaign's250ms claim polling; it is unrelated and can exhaust the60/min claim budget.

Cleanup uses owned browser/service/directory/peer close, restores both diagnostic wrappers and TLS connector, then removes owned Hub/fleet scratch. On a setup failure before the main try, still check process exit and remove only your own abandoned roots. Never kill by broad name/pattern.
