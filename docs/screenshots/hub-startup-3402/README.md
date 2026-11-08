# Hub startup eligibility budget (#3402)

The welcome used five concurrent authenticated reads: rooms, welcome, catalog,
notices GET, and the notice stream's initial snapshot. The existing Core limit
correctly admitted four and refused the fifth. This could hide the empty-agent
hint and show a generic failure on an otherwise ordinary page.

The notice stream already starts with the full snapshot. A new client mark
`pairingNoticeSnapshotV1` lets the notice component use that snapshot directly.
With a retained older client, the component completes the notices GET before
starting its stream. Without EventSource it keeps the GET. Welcome and catalog
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
MATRIX=full REPEATS=3 REQUIRE_NO_429=1 BUSY_CONTROL=1 SKEW_CASES=1 \
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

Receipts and representative screenshots are added after the source-bound run.
Physical driver peak alone is insufficient evidence: the broken baseline also
stays at four admitted reads. Ordinary attempted concurrency, absence of 429,
and the visible empty-agent hint are checked together.

Risk: on a retained client, notices wait for the bootstrap GET before subscribing.
If a stream cannot connect, EventSource keeps its existing reconnect behavior.
Rollback: revert this PR; the original five-read startup race returns. No state or
schema migration is involved.
