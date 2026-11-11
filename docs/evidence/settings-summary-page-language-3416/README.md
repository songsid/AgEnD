# Pending Settings summaries follow the page language (#3416)

The fleet renders the original confirmation once in its own locale. The page previously displayed that immutable text, including inherited-policy and secret-fingerprint labels, even when its language differed. This change carries optional versioned parts beside each original line and translates recognized parts at render time. The pending record, raw display fallback, chat text, digest, host ticket and audit keep their original inputs.

The server copies bounded display metadata before notification awaits; the browser accepts only its own known keys and argument shapes, a matching original line and a parallel versioned array. Missing, malformed or future metadata uses the existing fallback (including #3511's known Hub line). The formatter is registered in the existing shell module and adds no imported module or name, so a retained i18n module works.

## Evidence

- `fail-first.json`: four intended assertions fail on detached baseline `d98863926393b5071d0cd76c155783982a554ca1` with the candidate regression files copied in: two locale directions, producer metadata and immutable pending metadata. No module-load failure. Filter: `carries display|freezes display|generic summary independently`.
- `canonical.json`: 24 producer/refusal cases in each fleet locale (48 total), original outputs byte-identical before/after after excluding only `summary_i18n`. This covers original strings, fingerprint, classification, connection targets and record/unit refusals. Exact source/harness hashes and heads are recorded.
- `focused.json`: 168/168 across the 13 named files, including actual confirmation HTTP plumbing, same ticket, no raw secret, escaped identities, malformed descriptors and fallback. Source/test native typechecks pass. Style/i18n/named-link/search/split checks pass; corrected fragment metadata then passes 75/75 changelog checks.
- `mutations.json`: eight single reversals each cause assertion failures: HTTP propagation, proposal copy, fallback equality, version, argument shape, UI/store budgets and parallel container. Sources restored byte-exact; `restored.json` is 39/39.
- `browser/receipt.json`: clean pinned capture at `aa4dc3baedf2e45094d126ac284657454c1f1eda`, with git tree, source/harness and served-asset digests. Eight current desktop/phone × EN/zh-TW × light/dark cases, four exact-baseline asset controls, four retained controls (old shell/server/i18n/confirmation module), plus two in-page language switches: 16 cases / 18 PNGs. All cases deliberately use the opposite fleet locale. Original strings/fingerprints remain unchanged; zero effects, CSP violations or horizontal overflow. Browser, listeners, stores and scratch home were closed.

## Receipt representation repair

The initial required scan flagged digest values under token-like served-asset path keys. Only the receipt representation now uses ordered digest-first rows; the manual capture script emits that shape for future runs. All 2000 original path/digest bindings across 16 cases, metadata and 18 PNG bytes are retained. `receipt-normalization.json` records the original 764ca008 Git blob and both receipt digests; decoding the new rows reconstructs the original receipt byte-for-byte. This is not a new browser execution, and its original aa4dc3ba source/tree/input hashes are unchanged. No scan exclusion or product change.

## Browser scope and limitations

These are display fixtures made by the actual diff producer and confirmation store, then followed by the real Settings confirmation module in the authenticated app.html/Settings shell. Pending GETs are recorded projections. They prove display, retained assets, page language, layout and original record preservation; they do not claim a real Settings effect, remote chat delivery or end-to-end authority test. Production HTTP/store tests cover those unchanged boundaries separately.

All 14 selected original screenshots were visually inspected. Main's existing phone Withdraw control is 30px tall on both baseline and candidate; this patch changes neither that control nor CSS. Its measured dimensions are recorded and compared, rather than claiming a new 44px tap-size pass. No real account, live fleet, native runtime or backend CLI was used.

## Reproduce

Run the files in `focused.json`, then both native typechecks. Use an owned detached baseline and `BASELINE=<path> node_modules/.bin/tsx scripts/manual/settings-summary-canonical-3416.mts`. For browser captures set `REPO`, `OUT`, `BASELINE_REF`, isolated `HOME`, short owned `TMPDIR`, `PW_DIR`, `CHROME`, and `FONTCONFIG_FILE`, then run `scripts/manual/settings-summary-browser-3416.mts` with tsx. Capture requires a clean tracked tree and rejects any source change during execution.

Rollback: revert this change; original summary strings and all confirmation/security state retain their existing format. Unknown metadata already falls back safely. Alpha's additional effect summaries are a separate main-first twin.
