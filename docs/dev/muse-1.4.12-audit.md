# Muse Code 1.4.11-R6667.1 → 1.4.12-R6909.1 audit

Audit date: 2026-10-23. Isolation: private npm-less prefix, private HOME/XDG, private
tmux socket, echo provider and a local Meta Responses mock. No live AgEnD pane, no
real account. Binary sha256 `81e8bb16289203ba8e0ca7f80c4b82e59ba35f5ee50aafef93a2a4116f2cb27f`.

Conclusion: composer, prompt and dialog shapes exercised offline are the 1.4.11
shapes with the version string bumped. Trust dialog bytes match 1.4.11 after path
normalization. Echo idle differs only in `Muse Code 1.4.12`. Meta-done and echo-done
keep the same `❯` / `◆` / separator / status-bar grammar.

1.4.12 adds a rotating empty-composer hint. Isolated echo/mock idle never painted it
(bare `❯`, `-e` row `\x1b[0m❯`; separators are SGR 2). The live host paints
`Type @ to search and insert workspace file paths` grey in an empty box. AgEnD's
`museInputBox` treated that as typed text, so `clearRestoredInputDraft` returned
`foreign-draft` and delivery failed (`送達失敗`). Production captures are
`tmux capture-pane -p` (no SGR), so the detector matches the reconstructed composer
text with `museDraftShows` against the binary catalog, and also treats an `-e`
capture whose composer text is entirely faint as empty. A prefix of a hint, extra
characters, or ordinary typed text remains a draft.

The detector logs once at debug (`muse empty-composer placeholder classified as
empty`) with the composer `text` and raw `sgr` whenever it classifies a faint
placeholder as empty. The logger and once-set live on that Muse backend, so a
second instance cannot steal the evidence or reset deduplication. Production `capture-pane -p` has no SGR, so that path is
silent until an `-e` capture sees a real hint. Leader's 2026-10-23 live
`capture-pane -e` of agend-dev-muse was a bare `❯ ` (quota exhausted until
2026-10-26); reconstructed fixtures remain labelled as such.

Mark audited only after this PR passes parity review and is merged.

## Composer / prompt / dialog vs 1.4.11

| Surface | 1.4.12 vs 1.4.11 |
|---|---|
| echo idle | identical except `Muse Code 1.4.12` |
| echo after a turn | same empty `❯` box and `echo · … · Launch overrides` bar |
| meta after a turn | same empty `❯` box and `mock-model · high · … · Launch overrides` bar |
| first-run trust | byte-identical to 1.4.11 (`⟩ 1  Trust and continue` / `2  Quit`) |
| empty-composer hint | new; not painted under echo/mock; reconstructed fixture from live idle + binary string |

Ready pattern `❯|Muse Code \d` still matches. Idle proof now accepts the hint as
empty. Approval and quit-menu matchers were not re-exercised; their chrome is
unchanged in the captured trust dialog and in the 1.4.11 fixtures that remain
controls.

Fixture provenance is in [SOURCES](../../tests/fixtures/muse-1.4.12/SOURCES.md).
Tests use the production `MuseBackend`. The host Muse installation is unchanged.
