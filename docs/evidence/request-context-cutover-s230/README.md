# S-230 selected B: owner-control UI checkpoint

**DRAFT / USER LOOK HOLD. Production cutover assembly and full-mode proof remain unfinished.** The user chose B on 11-26, replacing A: default Off, explicit owner confirmation, readiness only at that attempt. No upgrade auto-enable or notice. Before an attempt, no blocked Needs-you item. Check again only checks. Off after activation retains the capable owner-only bridge, not lifetime origin permissions.

[Plan and update/Go-back contract](../../design/request-context-cutover-s230.md) · [Original PNG hashes/source bindings](pictures.json) · [Verification](verification.json).

## Actual-app evidence

128 originals: 16 states × desktop/phone × EN/zh-TW × light/dark. The real scratch FleetManager web listener, private host-session admission, Settings router/control API, Settings and Needs-you components, SSE/history and General chat render synthetic installer states. No text is injected into the DOM. No live Fleet, CLI, pane, provider/model/account or live home starts. Delivery and configuration-write fixture ports throw if reached. These are UI/status fixtures, not activation/full-mode proof.

States: on; Off after activation; default Off before first attempt; draining and its End this wait confirmation; legacy, Windows Runtime, agent, recovery and update blockers; On confirmation; On confirmation with an open Go back deadline; destructive stop-work confirmation; Off confirmation; unconfirmed change; General notice.

On has one confirmation with the permanent downgrade warning, plus the Go back deadline when offered. An unconfirmed write renders an indeterminate switch and a read-only Check again, with no blind repeat. Desktop blocker buttons share a row, asserted from bounding rectangles; phone actions may wrap. Stop this work has a warning confirmation. Legacy blockers name the messages and link to the existing Authorizations page. The version badge is the source checkout's package version: SettingsBuildVersion reads /api/fleet, whose FleetManager.currentVersion returns readInstalledBuild().version. This is not the running host's beta version.

The General notice uses the actual server text helper and real status-message SSE/history renderer. This proves wording/wrapping, not the future installer's durable once-per-epoch post.

## Sources and review

- [Full B receipt](capture-B.json): `bba838fd65f499e51b34a2f5cec44fe497ef8590`, 120 originals / 737 checks.
- [Action-row delta](capture-B-actions.json): `3930920b36d71ab7ccdfcd64a6b8b41b2ba3bf22`, 56 originals / 401 checks.
- [Sidebar recapture](capture-B-sidebar.json): same `3930920b`, one original / four checks.
- [Final wording/action round](capture-B-R2.json): `0c8ad02ace309af4cdff8b0701616bb71bbda1f1`, 72 changed/new originals / 469 checks.

Final set: 56 originals carried from the B checkpoint and 72 changed/new originals from the final wording round. Every final original was individually opened by read-only image reviewers. Desktop actions align; phone actions wrap without overflow. Full copy, confirmations, mixed switch state and warning contrast pass. No visual blocker, tofu or visible private value remained. The two finished offline galleries embed the exact PNG bytes, separated by screen size to meet the attachment limit; all 128 decoded hashes, browser image rendering and language filters are checked. They supersede the selected-A attachment.

Reproduce in private scratch homes only:

```sh
REPO=$PWD PW_DIR=$PWD OUT=$PWD/.artifacts/s230/look MATRIX=full npx --no-install tsx scripts/manual/request-context-cutover-s230/capture.mts
```

`STATES=...` supports bounded recaptures. Receipt sources bind each subset; later source changes only action arrangement/capture settling, leaving retained product views unchanged.

## Dormant safety components and checks

318 tests pass across 21 focused files at the final wording source; after adding the WAL-copy regression, the five affected suites pass 66/66. Test typecheck and changelog checks pass. The preparation tests include whole-Fleet port/peer readiness, immutable final-write inputs, exact Fleet lease, identity-only reads/verified writes, CSRF, role/session rechecks, revision CAS, quiet default Off, separate read-only recheck, update exclusion and the atomic activation marker. The earlier mutants remove update settlement or Go back refusal. The final helper mutant bypasses snapshot-history preservation; its negatives turn red and the source is restored. Earlier preparation mutants are retained evidence, not repeated campaign claims.

The update guard holds the actual Fleet ownership plus home update lock and SHARED state lease, refusing open/recoverable journals and a live legacy updater even when its journal is absent. The dormant activation transaction writes the floor and append-only activation/Go-back history together. Real SQLite controls prove pre-COMMIT failure rolls both back; after COMMIT Go back is refused without any retained.json cache update; later updates require the actual manifest-verified private read-only snapshot copy to preserve the complete activation history. Backwards-clock, missing snapshot, writable/altered snapshot and missing later-epoch controls refuse; exact later snapshots pass across clock shifts. Timestamp comparison never grants permission. No production updater/restoration path is invoked by these tests.

An unchanged neighboring cross-process test, `update-locks-m3770`'s missing-home SHARED case, fails locally on this branch **and untouched prior `6daa35da`** (19/20 pass). It uses a 1500 ms child lifetime. This evidence does not claim that neighboring suite is green or replace its cross-process proof. Source was left unchanged and the update author was notified.

## Production assembly and remaining gates

[The actual assembly receipt](assembly.json) supersedes the earlier dormant checkpoints. The stable Settings host, authoritative runtime capture, C/D pre-start owners, capable startup/publication and explicit Off recovery are now wired. Private full-mode fixtures run confirmed On through actual C → policy → E/I → B → receiving C for owner, Free-room, restricted-room, guest and Hub requests, including D1 onward release, unchanged actor/scope, stale-token refusal and all five private Hub reads. No test starts a live Fleet or provider.

The restored request/contact run passes **992/992 in 68 files**. Four targeted mutants are killed by assertions (verification, exact runtime snapshot, exact native run and the actual Settings module dependency closure). Typecheck and the production build pass. A broader 116-file neighboring run passed 2,968 tests with one skipped and one call-arity regression; the repair preserves the legacy argument shape, and its native-pane file plus two scoped neighbors then pass **113/113 across three files**. These scopes overlap; do not sum them.

Same-process and fresh-boot failed-publication Off, construction failure before Modes assignment, in-process stop/start, positive ordinary Stop retirement, complete-root collection, scoped approval outcomes and atomic stop-waiting outcomes are covered. A timer never proves an effect ended. An unconfirmed run stays in reconciliation, and roots without positive age evidence remain retained.

The PR remains draft/HOLD for Fable's implementation review, exact-head CI and the final supplemental user look. No fixture result authorizes live activation or a downgrade; after first enable, Off still requires the capable bridge and the older-binary barrier remains.

### Clock-order hardening after the B checkpoint

A new negative reproduced an omitted-attempt case at the previous helper: update commit stamped 3000, activation after a backwards clock step stamped 2000. The old timestamp fallback returned true. The replacement requires the verified, read-only candidate snapshot to retain exactly the live activation history and valid compatibility barrier. Explicit invalidation remains a refusal. The optional fourth parameter preserves call compatibility but missing snapshot evidence now refuses on an activated home. This changes only dormant helper/tests/docs; UI, CSS, capture recipe and every PNG remain identical to the B checkpoint. S-245 was notified before its Go back consumer is implemented. A checkpointed WAL-format snapshot control uses a SHA-256-verified private copy and proves the immutable source directory and bytes remain unchanged.

## Conditional first-On restart disclosure

The Leader authorized one conditional confirmation line after Fable confirmed that hot-binding an existing persistent launch is unsafe. [Sixteen new confirmation originals](restart-pictures.json) and their [receipt](capture-restart-confirm.json) use source `c0319e5be7049b9da5339b01cf415867b91c82bc`, 113 checks, with two fixture agents, both languages/themes/screen sizes, with and without Go back. Every original was individually reviewed; the complete warning, date, conversation-preservation line and buttons fit. The other 128 original views carry unchanged: no new line when no relaunch is needed. The finished confirmation supplement embeds all 16 exact PNGs, with decoded hashes and browser rendering checked.

This proves only the conditional UI. Controlled physical stop/IPC retirement, pre-start C/D replacement binding, negotiation, failure restoration and late-call generation fences are production assembly work, not established by these captures. The server supplies the count; a decision body attempting to set it is rejected.

Retained human controls: `human-control.json` binds the exact source and restored tests, including the real Fleet facade/pane judge, raw/begun refusal controls and mutation results. This is an assembly checkpoint, not activation or full-mode acceptance.

Accepted human ingress: `human-input.json` binds the atomic companion/facade, explicit guest facts, indexed durable references, retirement and pruning controls. It records the prior-source pane-fixture diagnostic and the isolated inert-executable run separately. Final-write and complete installation remain unfinished.

Current request admission: `registered-access.json` binds the SDK registration evidence, native/web current-access checks, current room-mode behavior and seven mutation controls. Creation allowlists are kept separate from registered-room message admission. This is not full-mode or activation acceptance.

Final human write: `human-resolver.json` binds the actual facade/formatter/C/pane-judge composition, stale-owner and anti-laundering controls. It is not a complete production installation or full-mode acceptance.

### Delivered reply-route checkpoint

[Source and proof binding](reply-route.json): all four real web producers capture their admitted browser independently of account recognition. The original human companion supplies the post-paste guard’s immutable destination, bound to the C token and generation. Registered returns can use the original source’s route; other peers and unknown recovery cannot. Restored:391/14; eight guard mutants red; types clean. This prepares the route only: unknown outputs stay refused until the actual sinks preserve and enforce the captured audience. Production assembly/full-mode proof remains unfinished. No UI or captured image changed.

### Original-call reply sinks

[Sink source and proof binding](reply-sinks.json): local/pane call capture and the Fleet IPC wrapper preserve the same delivered route lease. The actual reply/edit/react sinks force its original adapter/chat/thread and recheck it after awaits. Unknown non-Hub outputs work only on that proven path. Web reactions preserve existing visibility and mirror only that destination. Raw system proxy text has no originating tool lease and cannot borrow a chat under C. Restored542/21; nine guard mutants red; types/public/Gitleaks clean. Existing browser visibility and UI/image bytes are unchanged. Production installation/capable boot/full-mode assessment remain unfinished.

### Controlled owner and transport components

[Source and focused checks](prepared-owners.json): one candidate preparation binds the actual pre-start C/D hook and rendering policy; work retention joins the activation transaction, with a separate post-commit seal. Transport observations use actual negotiated connections/open ports, not advertisements or registry presence.85/6 focused tests plus one managed-factory case pass; types/public/leaks clean. This does not assemble or publish the complete installer. Physical retirement/reconstruction, exec/grant wiring, standard Settings confirmation, capable boot and full-mode proof remain unfinished. UI/images unchanged.

### Real application module closure

The final browser fixture caught an incorrect public-asset import of the private Settings confirmation module. It prevented Settings from loading despite the controller/route tests passing. The control now imports `./settings-confirm.js`. The new closure regression walks both authenticated Settings/Needs roots, follows all static imports, and requests public dependencies from the real private fixture listener; restoring the wrong asset path makes it red. The restored app-module suite passes 40/40, and the app-module, standard confirmation and actual-controller suites pass 64/64 across three files. This changes module loading only; existing approved layout, wording, CSS and PNGs are unchanged.

### Final user-look supplement

[The final capture receipt](completion/capture.json) binds **24 real-app originals and 64 checks** to source `e04ef2cf58327a8aae91c0b976e873f5070b3c71`: the standard Settings pending card with expanded details, the delegated reply's destination refusal, and the stop-waiting outcome. Every EN/zh-TW × desktop/phone × light/dark original was individually opened in the [read-only visual review](completion/review.json); no visual blocker was found. `v1.22.0` is the fixture badge. All previous approved PNGs remain byte-identical.

The finished offline gallery embeds the exact 24 PNGs (decoded hashes and real-browser image/filter behavior verified). It is delivered on S-230 as one HTML attachment. It is a supplemental user look, not a live enable action. Ordinary non-Hub status notices retain their established timestamp/quote-rule presentation without a visible sender heading, and the phone's ordinary copy control; no stylesheet was changed to recast that existing style.

S-249 remains open on the board; S-250 is done. This receipt does not lift that prerequisite, the user look, Fable's formal gate, or draft/HOLD.

### Pending-card R1 after the Leader's capture check

Only the eight Settings-pending originals were re-captured at `0d2bfe847fb9a474fdd7dc3f10e093b774264783`; the sixteen accepted destination/outcome frames retain their exact original hashes. The [mixed final receipt](completion/capture.json) records each image's own source and 88 checks; [the eight-frame receipt](completion/pending-r1.json) has 48 checks. All eight replacements were individually opened and passed.

A short irreversible-version consequence now sits above the pending details. It is derived only from the server's canonical On summary, remains visible with details collapsed, and adds no authority or action. The shared pending renderer shows the General directions only when this viewer has no Apply now action; revoked/refused Apply now still falls back to the existing General flow. Execution, confirmation digests, role checks and store decisions are unchanged. The badge is fixture-only `2.4.0-beta.25`, with no real package/release change. The three focused suites pass 118/118; typecheck and build pass.

The finished attachment is **S-230-final-control-views-R1.html**. It supersedes the earlier gallery's eight pending frames; the accepted chat frames are unchanged.

### Exact-head CI repairs

The bounded owner-app metadata route no longer reads the request-context control host: that read is lazy on the exact control route. Go back deadline rendering uses the shared clock helper; Traditional Chinese now uses 24-hour time in the browser On confirmation and server pending summary. This formatting delta is included in the eight pending replacements; no additional On-confirm frames were generated. English formatting and all other approved frames are unchanged.

The Hub reservation test was reproduced red when its one-minute advance crossed midnight and expired its “today” code. Its private clock now advances against a one-hour code, isolating reservation expiry. No production Hub route or source changed. The five repair suites pass73/73; test typecheck and build pass. The existing eight pending/role/page-language/summary neighbours pass266/266. These checks do not authorize live activation.
