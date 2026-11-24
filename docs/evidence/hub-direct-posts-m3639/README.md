# Hub one-to-one agent posts — phase 1

Synthetic, owned scratch Hub/SQLite/member/browser only. No live Fleet, account, provider or model call.
The user approved phase 1 on 2026-11-24 without an hourly cap. Mute remains in this slice.

## Evidence

- `tests/hub-direct-posts-m3639.test.ts`: real encrypted audit storage and HTTP/member paths; previous question,
  standalone text/files, exact operation idempotency, history/paging/unread/read, owner/person/mute/grant/link
  refusals, audit rollback, no hourly cap and content-based duplicate control (including ordinary answers).
- `tests/hub-direct-posts-protocol-m3639.test.ts`: actual negotiated link, old-member refusal, 19→16 legacy hello,
  answer-size text/files-only direct bodies and unchanged group bounds/attribution.
- M-3639 cases in `tests/hub-room-post-fleet.test.ts`: current consent, uncertain lost reply, concurrent coalescing,
  frozen file refs after restart, changed file content, old Hub and list-derived direct IDs.
- Base proof: the standalone-commit case fails on `9f9c34dfd` with `ok:false` rather than `ok:true`; the same test
  passes on this implementation. The temporary detached base worktree was removed with `git worktree remove`.
- Focused review run: 143/143 in 11 files. Source and test TypeScript checks pass. Exact PR CI remains the wider check.
- Five semantic mutants each fail an assertion: bypass mute, bypass duplicate guard, omit the encrypted-content audit anchor, ignore current consent during staging, and ignore changed file contents. All source was restored.
- Browser: 44 checks through real HTTPS Hub routes and the actual UI, including a real `room.post` with a staged file,
  SSE appearance, mute persistence/refusal and no horizontal overflow. All 16 original PNGs were inspected; the 8 mute
  views were re-shot after toast dismissal so their checkbox text is visible.

## Captures and style guide

`desk-*` is 1366×900; `phone-*` is 390×844. Every device/theme/locale has `*-message.png` and `*-muted.png`.
Only generic fixture labels and a synthetic `summary.txt` appear. Screenshots prove rendering, not provider activity.

Checked against `docs/design/ui-style-guide.md`: rules 1–5 use the existing room thread, attachment card, Menu checkbox
and toast, with no custom frame, CSS, inline styles, colors or type sizes. Rules 6–10 retain existing room loading and
failure flows, provide localized plain-word preference outcomes, use the same room menu, and wrap at phone width.
Rules 11–14 keep Agent/Fleet terms, shared menu icons and the existing Hub shell; there is no new info icon.
EN and zh-TW, light and dark, desktop and phone are all represented.

Reproduce with installed Linux headless Chromium, Playwright and a CJK font:

```sh
OUT="$PWD/docs/evidence/hub-direct-posts-m3639" \
CHROME=/path/to/linux/chrome CJK_FONT=/path/to/cjk-font.ttf PW_DIR=/path/to/node_modules \
npx tsx scripts/manual/hub-direct-posts-m3639/browser.mts
```

The browser blocks all foreign origins and uses a unique temporary home and scratch TLS server. It cleans up on exit.
The shared toast is allowed to disappear before the mute image; no mock markup or screenshot editing is used.

## Risks and rollback

Standalone Hub storage is additive and separate from question/answer delivery. A member rollback keeps its strict
question journal unchanged; saved post successes exclude the new display-only result field. Stop the feature and
restore the pre-change Hub database backup before a server downgrade that cannot recognize the new schema component.
Retain the new database separately if standalone history must be recovered later; do not delete or reinterpret rows.
Ordinary answers, group posts and M-3160 peer-contact restrictions remain on their existing paths.
