# ClassicBot room backend picker

A ClassicBot room previously reached the Fleet-only refusal in `/backend`.
It now uses the same backend → model → effort → confirm flow on web,
Discord and Telegram, with the existing room-admin gate. The final write
uses the Classic Settings leaf writer, credential-profile check, owned
restart and conflict-aware rollback. No switch happens between steps.

Each CLI keeps its own saved account mapping. A room effort override is
persisted, retained by later Classic saves, and passed to the actual launch
configuration. Default selections clear the corresponding room override.
A stopped room stays stopped. Missing, ambiguous or changed targets refuse
the switch; room identity, on-disk configuration and inherited defaults are
checked again after discovery and before writing.

Restricted rooms show the guard-coverage disclosure above the final switch:
coverage is checked when the AI tool starts; an uncovered tool or version
runs with its normal permissions, with contact approval still applying.
The disclosure does not claim native coverage for any selected backend.

## Verification

`validation.json` records the two fail-first cases, the seven-file focused
run, the final eight-case delta and both TypeScript checks. The delta adds
one new admin-revocation regression and repeats seven confirmation cases;
the pass counts should not be added as distinct tests. Four deliberate
reversals fail semantically: missing disclosure (6), missing configuration
snapshot check (4), lost account mappings (2), and missing launch effort (1).
Every reversal was restored before final validation.

The tests also cover guest/non-admin refusals, owner-only native buttons,
revocation during confirmation retirement, held discovery, changed inherited
settings, stopped rooms, one-use confirmations, signed-out target profiles,
exact rollback after restart failure and preservation of a newer conflicting
edit. Related Settings restore/profile suites exercise the shared writer.

## Rendered views

The eight PNG originals in `screens/` show backend selection and final
confirmation in EN and zh-TW, at desktop and phone widths. The synthetic
room uses the real app chat, command route and existing CommandCard/dialog;
model lists, account probes and lifecycle operations are stubs. All four
flows reach confirmation without a file change, page error, CSP violation
or horizontal overflow. The confirmation includes the restricted-room
notice. A built-in image reader checked all eight originals for clipping,
glyphs, the visible notice and private data. This is rendered-view evidence,
not user acceptance or a live vendor/transport proof.

The browser ran headless on Linux, closed after capture, and its disposable
fixture folder was removed. No live account, external model, Windows window
or live room was used. `capture-results.json` records each flow and cleanup;
`hashes.json` identifies the original artifacts. No raw logs, account files
or expanded host paths are published.

## Rollback

Revert the picker/Settings integration and its tests. Existing room backend
and model fields retain their usual meaning. The new optional effort field
has no migration; an older binary does not use it. A failed switch uses the
existing owned restart compensation and restores only fields still owned
by that write; a newer conflicting edit is preserved and reported.
