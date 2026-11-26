# S-230 selected B: owner-control UI checkpoint

**DRAFT / USER LOOK HOLD. Production cutover assembly and full-mode proof remain unfinished.** The user chose B on 11-26, replacing A: default Off, explicit owner confirmation, readiness only at that attempt. No upgrade auto-enable or notice. Before an attempt, no blocked Needs-you item. Check again only checks. Off after activation retains the capable owner-only bridge, not lifetime origin permissions.

[Plan and update/Go-back contract](../../design/request-context-cutover-s230.md) · [Original PNG hashes/source bindings](pictures.json) · [Verification](verification.json).

## Actual-app evidence

120 originals: 15 states × desktop/phone × EN/zh-TW × light/dark. The real scratch FleetManager web listener, private host-session admission, Settings router/control API, Settings and Needs-you components, SSE/history and General chat render synthetic installer states. No text is injected into the DOM. No live Fleet, CLI, pane, provider/model/account or live home starts. Delivery and configuration-write fixture ports throw if reached. These are UI/status fixtures, not activation/full-mode proof.

States: on; Off after activation; default Off before first attempt; draining; legacy, Windows Runtime, agent, recovery and update blockers; On confirmation; On confirmation with an open Go back deadline; destructive stop-work confirmation; Off confirmation; unconfirmed change; General notice.

On has one confirmation with the permanent downgrade warning, plus the Go back deadline when offered. An unconfirmed write renders an indeterminate switch and a read-only Check again, with no blind repeat. Desktop blocker buttons share a row, asserted from bounding rectangles; phone actions may wrap. Stop this work has a warning confirmation. Legacy blockers name the messages and link to the existing Authorizations page. The version badge is the source checkout's package version: SettingsBuildVersion reads /api/fleet, whose FleetManager.currentVersion returns readInstalledBuild().version. This is not the running host's beta version.

The General notice uses the actual server text helper and real status-message SSE/history renderer. This proves wording/wrapping, not the future installer's durable once-per-epoch post.

## Sources and review

- [Full B receipt](capture-B.json): `bba838fd65f499e51b34a2f5cec44fe497ef8590`, 120 originals / 737 checks.
- [Action-row delta](capture-B-actions.json): `3930920b36d71ab7ccdfcd64a6b8b41b2ba3bf22`, 56 originals / 401 checks.
- [Sidebar recapture](capture-B-sidebar.json): same `3930920b`, one original / four checks.

Final set: 63 retained full-matrix originals and 57 replacements. Every final original was individually opened by read-only image reviewers. Desktop actions align; phone actions wrap without overflow. Full copy, confirmations, mixed switch state and warning contrast pass. No visual blocker, tofu or visible private value remained. The two finished offline galleries embed the exact PNG bytes, separated by screen size to meet the attachment limit; all decoded hashes, browser image rendering and language filters are checked. They supersede the selected-A attachment.

Reproduce in private scratch homes only:

```sh
REPO=$PWD PW_DIR=$PWD OUT=$PWD/.artifacts/s230/look MATRIX=full npx --no-install tsx scripts/manual/request-context-cutover-s230/capture.mts
```

`STATES=...` supports bounded recaptures. Receipt sources bind each subset; later source changes only action arrangement/capture settling, leaving retained product views unchanged.

## Dormant safety components and checks

315 tests pass across 21 focused files; test typecheck and changelog checks pass. The preparation tests include whole-Fleet port/peer readiness, immutable final-write inputs, exact Fleet lease, identity-only reads/verified writes, CSRF, role/session rechecks, revision CAS, quiet default Off, separate read-only recheck, update exclusion and the atomic activation marker. Two new mutants remove update settlement or Go back refusal; both turn their negatives red and are restored. Earlier preparation mutants are retained evidence, not repeated campaign claims.

The update guard holds the actual Fleet ownership plus home update lock and SHARED state lease, refusing open/recoverable journals and a live legacy updater even when its journal is absent. The dormant activation transaction writes the floor and append-only activation/Go-back history together. Real SQLite controls prove pre-COMMIT failure rolls both back; after COMMIT Go back is refused without any retained.json cache update; later updates remain eligible. No production updater/restoration path is invoked by these tests.

An unchanged neighboring cross-process test, `update-locks-m3770`'s missing-home SHARED case, fails locally on this branch **and untouched prior `6daa35da`** (19/20 pass). It uses a 1500 ms child lifetime. This evidence does not claim that neighboring suite is green or replace its cross-process proof. Source was left unchanged and the update author was notified.

## Remaining implementation

Production FleetManager still supplies no cutover/control host and stays capability 0. No actual activation can occur from this checkpoint. Actual ingress/audience adapters, complete owner installation/publication, failed-install Off, concrete drain resolutions and outcomes, update Go-back consumer integration, conditional skills, once-only notice posting, full-mode/crash/rollback fixtures and prerequisite/user gates remain required. No completion or formal implementation approval is requested yet.
