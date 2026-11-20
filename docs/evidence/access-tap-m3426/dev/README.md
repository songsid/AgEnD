# Dev integration — M-3426

Main #4260 merged as ccd566e8b6581ed7a7309f415c8e2221a8af80fa before this standalone twin was created from dev tip 22af8451812b4d2153b813261631ba700d1882d2. The same two-line shared phone Settings rule is added without changing incoming Settings styles.

The tap-allowance list has evolved on dev. Preserve its unrelated entries; remove only the compact-button allowances now covered by the common 44px rule. Six of main's thirteen deleted keys still existed on dev, and eleven newer button keys are also obsolete. No allowances are added. The full gate also exposed thirteen pre-existing stale non-button entries and five switch-label exceptions made obsolete by the shared hit-area fix, which are removed under the approved dev integration scope.

The parent directory preserves historical main proof, including its source hashes and inspected main phone capture. Those hashes describe main, not this newer dev tree. This directory contains the current dev gate results, capture and source manifest. No repeated main provider, native or browser campaign is claimed.

Both actual merges and their green post-merge CI are required before completing the card. No authentication or token-storage behavior changes. Roll back with a normal revert of this twin; no data migration.

## Dev-only switch defect

The English phone Web dashboard thinking switch also failed with unchanged dev base CSS. Its visible switch is 38 × 22px and its associated inline label did not provide a sufficient target. This defect is dev-only, so it has no main twin. The Leader approved a shared-label hit-area fix here: transparent block padding balanced by negative margins extends the clickable label while preserving text alignment and document layout.

Before/after English and zh-TW phone originals are under `captures/`. Each language pair is byte-identical. Geometry checks find no change to card height, row height, text, notes or switch positions; the associated label hitboxes exceed 44px. All five dev phone originals were visually inspected for layout and private data. Access's Refresh action measures 44px on phone and the unchanged30px on desktop. No credential or provider call was made.

## Final validation

- Full eight-case Settings gate: **635 checks passed**, including every section, intermediate widths, gate self-tests and stale-allowance check.
- Final CSS balance and literal ratchet: **43 tests passed** across two files. Changelog: **693 fragments valid**.
- The baseline dashboard probe swaps only the CSS to the unchanged dev base; it reproduces the English thinking-switch failure. It also reports expected old button failures because the already-shrunk allowance list remains in that probe. No allowance was added to hide a failure.
- Dev allowance diff: **35 entries removed, zero added** (17 buttons, 13 previously stale entries, 5 switch-label entries now covered).
- Main post-merge CI, data-downgrade and Gitleaks all completed successfully on ccd566e8; exact run IDs are recorded in `main-post-merge.json`. Dev exact-head and post-merge CI remain separate release checks.
