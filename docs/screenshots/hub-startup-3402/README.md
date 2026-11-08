# Hub startup eligibility budget (#3402)

The welcome used five concurrent authenticated reads: rooms, welcome, catalog,
notices GET, and the notice stream's initial snapshot. The existing Core limit
correctly admitted four and refused the fifth. This could hide the empty-agent
hint and show a generic failure on an otherwise ordinary page.

The notice stream already starts with the full snapshot. A new client mark
`pairingNoticeSnapshotV1` lets the notice component use that snapshot directly.
With a retained older client, the component completes the notices GET before
starting its stream. Without EventSource it keeps the GET. A terminal CLOSED stream falls back to an
authenticated GET, with visible busy/unavailable status and Retry-After recovery.
After a successful fallback it waits 10 seconds before re-subscribing, avoiding
a GET/stream rejection loop at the 64-stream cap. Transient CONNECTING errors
keep EventSource's native reconnect behavior. Welcome and catalog
remain parallel. Directory admission limits, current eligibility checks, and
all mutation/confirmation boundaries are unchanged.

Welcome and group-editor reads display explicit busy text and retry after the
server's Retry-After delay (10 seconds today). Retries perform fresh read-only
requests. Their timers and late results are fenced by the mounted component and
read generation. No Save, pairing, revoke, or other mutation is retried. New copy
is registered in its own served module so retained group translations still work.

## Reproduce

Run `scripts/manual/hub-quick-pairing/startup-3402.mts` from the checkout being
reviewed, with an existing Playwright installation and Chromium executable:

```sh
REPO="$PWD" ART="$PWD/.artifacts/3402/browser-final" \
OUT="$PWD/.artifacts/3402/browser-final/png" \
PW_DIR=/absolute/path/to/playwright-install \
CHROME=/absolute/path/to/chromium \
FONTCONFIG_FILE=/etc/fonts/fonts.conf TMPDIR=/short/owned/private/directory \
MATRIX=full REPEATS=3 REQUIRE_NO_429=1 BUSY_CONTROL=1 SKEW_CASES=1 NOTICE_CONTROL=1 \
node --import tsx scripts/manual/hub-quick-pairing/startup-3402.mts
```

Use `MODE=before MATRIX=quick REPEATS=1 REQUIRE_NO_429=0` for the retained-f61 UI
control. The script's default old ref is pinned. No API response is replaced.
Ordinary startup is not delayed or serialized. Only the separate busy controls
hold four owned synthetic-directory promises to exhaust real admission slots.
The stream, polls, requests and physical directory reads drain between contexts.

The rig uses a sealed Hub HTTPS listener, the production AD driver, and an owned
synthetic verified-TLS/BER peer. The connector redirects only the rig's explicitly
configured loopback 636 endpoint to that peer. Browser TLS is accepted only in
the isolated browser context. All people, groups and secrets are fake. It starts
no fleet, member, agent, model, daemon or native CLI and touches no real account,
directory, pilot or trust store.

## Automated checks

- Four selected fail-first cases failed by assertion on the baseline (35 other
  cases deliberately unselected): duplicate notice GET, full-page peak five,
  welcome backpressure wording and the missing catalog retry/empty guidance.
- Seven focused suites: 171/171 assertions passed, zero skips; production build
  and test TypeScript checks passed.
- Nine individual guard reversals each caused assertion failures: duplicate
  snapshot bootstrap, retained-client GET/stream overlap, unsupported
  EventSource snapshot mark, welcome busy text, hidden catalog refusal, welcome
  delay, admin busy text, admin delay, and admin timer cancellation.

## Source-bound browser evidence

Source `12880158f5d15137a863360cf2d16fc6d53b16bc`:
24 fresh pages (eight desktop/phone × language × theme combinations, three each)
all show the empty-agent hint, have no 429, and attempt at most four concurrent
Core eligibility reads. There are 51 explicit browser checks, three separate
real-429/recovery controls, and two retained-module controls. The normal startup
and genuine-capacity controls are recorded separately in `startup-receipt.json`.

The retained-f61 UI control reproduced attempted peak five, admitted driver peak
four, catalog 429 with Retry-After 10 and no empty-agent hint on desktop EN.
The phone zh-TW baseline attempt did not hit the timing race (peak four, hint
visible). `baseline-receipt.json` records this static-UI substitution on the same
authorization backend; it is not a second old-binary deployment. Cleanup also
finished with zero reads.

The busy controls use actual 429 responses with Retry-After 10. EN desktop and
zh-TW phone welcome reads, plus the admin editor read, show busy text and recover
through fresh requests after the specified delay. Four occupied requests settle
normally. Retained `hub-client.js` and `hub-group-strings.js` controls preserve
bounded startup and the empty hint; busy welcome controls also retain old group
strings. Retained old notice consumers need a refresh to get the startup fix.

`startup-cleanup.json` records completed closure and zero physical directory
reads left. No browser errors, CSP violations or foreign requests occurred.
`checks.json` records focused/mutation counts and hashes of the 14 representative
PNGs. Browser receipts bind the source commit; the follow-up evidence commit
changes docs/screenshots only.

| Screens | Coverage |
| --- | --- |
| `desk-{light,dark}-{en,zh-TW}-1.png` | Desktop welcome and empty-agent hint |
| `phone-{light,dark}-{en,zh-TW}-1.png` | Phone welcome and empty-agent hint |
| `*-busy-ungranted.png` | Real backpressure, explicit busy text |
| `*-busy-admin*.png` | Editor busy state and automatic recovery |
| `skew-*.png` | Current UI with retained client/translation module |

An image-only review of all 14 samples found no blocking visual issue or private
data. Phone EN captures end across the lower Connect card edge; its text is
readable, but these static captures do not prove vertical scrolling behavior.

Physical driver peak alone is insufficient evidence: the broken baseline also
stays at four admitted reads. Ordinary attempted concurrency, absence of 429,
and the visible empty-agent hint are checked together.

Risk: on a retained client, notices wait for the bootstrap GET before subscribing.
A refused stream uses the bounded GET/re-subscribe recovery above; transient
stream disconnects keep their existing reconnect behavior.
Rollback: revert this PR; the original five-read startup race returns. No state or
schema migration is involved.
