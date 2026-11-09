# M-2779 — Hub confirmation language and Stop wording

#3511 came from a locale boundary: the immutable Settings diff uses the Fleet's language, while its browser card uses the page's. The shared card now translates only the two complete, recognized EN/zh-TW connection summary forms. The exact target remains text; the stored proposal, id, digest, authority and confirmation controls are unchanged. Unknown/extended lines remain visible verbatim. The existing shared shell contains its own dictionary and adds no new module dependency.

For #3512, **Stop remains a service pause**. Its dialog and both client/server confirmation summaries now say that still-valid sign-ins can resume after Run. Explicit sign-outs and expiry still refuse the old token. Ordinary fences also serve remounts, and the directory epoch belongs to the sealed settings/rotation protocol; neither is a safe generic bulk-sign-out hook. A distinct durable bulk-revocation operation needs its own lifecycle/recovery design. This patch changes no session behavior, schema, grant or authentication rule. See `docs/design/hub-stop-and-confirmation-copy.md`.

## Evidence

- Fail-first: two cross-language mounted cases fail on the earlier renderer; both EN/zh Stop-copy cases fail on the earlier signed-out promise. Candidate passes **213/213** across 13 files, with source/test types passing. The clean alpha sync to `138c8e55` leaves all three production blobs unchanged; focused checks pass on the combined head.
- Real Stop/Run control: sealed HubRuntime, HTTPS, production AD against an owned verified LDAPS peer. Listener refuses while stopped; after Run, a valid token works while explicitly signed-out and expired tokens remain refused. No real directory/account/Fleet/native/CLI/pilot operation.
- Before and after: four desktop/phone EN/zh cases each, **31 checks / 12 PNGs** per run, inside real Settings → Hub. The actual pending Start is refused to proceed until local confirmation; both the Settings card and waiting popup are read, then the exact request is withdrawn. The dummy Hub address is never contacted. No API replies are replaced.
- The Stop-dialog browser fixture projects an initialized config to draw its existing control; it does not start a Hub there. Its Cancel preserves Run. The separate runtime test above proves actual Stop/Run behavior. Do not read the dialog images as a combined host-runtime acceptance journey.
- SKEW: four combinations, **8 cases / 64 checks / 24 PNGs**. Earlier shell retains its earlier English summary; earlier Run module retains its earlier wording; earlier i18n with the new shell renders the new translation; new shell/Run static files on the earlier backend render correctly. These are static-blob substitutions only, with real API replies and confirmation gates.
- Settings Hub style gate: **62 checks**. Its stock fixture does not create a pending company request or initialized Hub; the separate browser matrix measures the actual changed copy, overflow and the dialog's Cancel/Stop actions at 44px. The unchanged Close X is a pre-existing 36px control, outside that action-size claim.
- Seven independent guard reversals fail collected assertions: rendering localization, target retention, unknown-line fallback, each of the three Stop wording surfaces, and a forbidden network-copy injection outside the exact scanner exceptions. Originals are restored.
- Image-only review of all 12 final after PNGs plus matching before shots found no new visual defect. Phone zh waiting capture has a pre-existing framing limit: the lower Review-local-confirmation button meets the bottom navigation; the confirmation summary itself is intact.

The main twin carries only the shared renderer, unit tests and narrow wording-scan exception. Its main Settings display fixture is explicitly synthetic, because main has no company-join backend.

## Capture provenance correction (R1)

The original `before`, `after` and `skew` receipts and PNGs are preserved byte-for-byte. The after and retained-asset matrices ran before the source commit, in a modified tree based on `95fbbd1a`. Their receipts recorded only HEAD, not a dirty flag or capture-time source/served-asset hashes. They are historical visual/behavior observations; they do **not** establish an exact committed-candidate provenance binding. The later source equality checks and artifact manifest do not retroactively supply that missing binding.

`pinned-r1/` is a fresh, separately executed control, not a relabeling of those executions. Each receipt records capture start/end, the exact server and runner commits/trees, an empty `src`/`scripts` status before and after, relevant source-file digests, the harness digest, and the browser-observed shell/Run/i18n/CSS response digests. Each substituted static asset records its exact commit, source path and digest. The shell and Run response digests must equal their selected committed source, and the source images must remain fixed. Only static assets are substituted; API replies and pending confirmations are real as before.

The five fresh quick controls pass **10 cases / 95 checks / 30 PNGs** (candidate, old shell, old Run, old i18n and candidate modules on the earlier backend). They cover desktop EN and phone zh-TW, rather than claiming a repeat of the original full EN/zh desktop/phone matrix. Product source is unchanged from reviewed `a58794f9` / source `1903cfe5`. The separate real Stop/Run test and original visual/style limitations above retain their stated scopes. All six fresh candidate images were reviewed; the same phone waiting-page framing limit remains. A preliminary provenance-harness run completed the UI cases but failed reading an unrelated transient asset after navigation. The collector was limited to its four relevant static dependencies before the fresh passing runs; product source did not change.

## Reproduce

Set owned `PW_DIR`, `CHROME` and a CJK-capable `FONTCONFIG_FILE`, then:

```sh
npm test -- tests/web-pending-hub-summary-3511.test.ts tests/hub-stop-copy-3512.test.ts tests/hub-stop-sessions-3512.test.ts tests/hub-company-join-wait.test.ts tests/hub-company-join-ui.test.ts tests/hub-run-settings-m2682.test.ts tests/hub-settings-fleet-m2682.test.ts tests/named-link-test-2906.test.ts tests/i18n-ui-literals-2390.test.ts tests/settings-control-ui-1423.test.ts tests/web-confirm-1408.test.ts tests/ui-css-literals-ratchet.test.ts tests/changelog-fragments.test.ts
npm run typecheck
npm run typecheck:tests
REPO="$PWD" OUT="$PWD/.artifacts/p3-matrix" MATRIX=desk-light-en,phone-dark-en,desk-light-zh-TW,phone-dark-zh-TW node --import tsx scripts/manual/hub-p3s-m2779/accept.mts
```

`BEFORE=1 REPO=<owned 95fbbd1a checkout>` draws the earlier UI. `MATRIX=quick SKEW=old-shell|old-run|old-i18n` retains that exact baseline module. For `old-server`, set `REPO` to the owned baseline and `CANDIDATE` to this checkout; only the two named static modules are new. Set a distinct `HP` for concurrent owned listeners.

Run `node scripts/manual/hub-p3s-m2779/verify.mjs` alone, with no browser/type/test job reading its modified files. It restores each original in `finally`. The digest-first manifest covers this PR's files and evidence, excluding itself. Reverting the UI/text commit restores earlier copy without changing any persisted session/configuration.
