# Combined B1/B2/U2 campaign — prepared, unlaunched

Run only after the leader's explicit timed GO following the alpha.15 rehearsal.
U2/B1/B2 target alpha.16. First sync the landed dependencies and verify the exact
candidate. The current window allocation leaves `explicitGo` false. Preparation
has run no Docker command, browser, Fleet service, directory or capacity wave.

## Entry and stop

`bash scripts/manual/hub-enrolment-code-campaign/run.sh --plan` prints a template
and reads Git only. With no argument, the script prints usage and exits. After
verifying the actual delivered GO, fill the template's exact source SHA,
`goReference`, `explicitGo: true`, and `from`/`until` UTC epoch milliseconds. The
window is at most two hours. Review the source-build version stamp too. Save the
plan privately, then use `--run <plan.json>` **only within that GO window**.
The plan is an accidental-launch interlock; it does not establish authority.

An attempt owns `.artifacts/hub-enrolment-code-campaign/ACTIVE`; its `output`
file names the attempt directory. On any reported overlap, create that attempt's
`control/STOP` immediately. The supervisor checks once per second, stops its own
child process group, and escalates after ten seconds. SIGINT/SIGTERM also stop
the attempt. Cleanup stops a Docker CID only after matching its random owner
label, and removes only the owned active marker. No automatic retry is present.

The launcher snapshots committed source only, refuses tracked modifications and
SHA drift, and requires both digest-pinned base images to be cached. It performs
no pull or package install. Its Docker config is private and empty. The single
container has no network, no capabilities, no new privileges, a read-only root,
2 CPUs, 3 GiB memory with no extra swap, 256 PIDs, 256 MiB shared memory and a
1.5 GiB private tmpfs. It has no host lifecycle, pilot or user-state mount.
Dependency modules are mounted read-only. Images are unchanged from B1's kit.

## Sequence and evidence boundaries

1. Compile the exact source and copy its UI. Package version is stamped only in
   private `/tmp/package.json`, as a source build; this is no release/package
   claim. Provenance and the receipt retain the exact SHA. A CJK-font preflight
   refuses screenshots when the image has no matching font.
2. Protocol legs B-L1–8 run the existing owned store, HTTP, permit, audit and
   upgrade suites serially. Injected-clock and inert-transport test boundaries
   remain explicit in those tests. No runtime result is inferred from test names.
3. Capture actual Administration create/group-scope/live/reloaded/ended views in
   EN/zh-TW, desktop/phone, light/dark. All requests use the real session/CSRF API.
   Group suggestions use the committed synthetic LDAP wire's prefix/extensible
   filter support; there is no private fake-AD patch.
4. B-L11: 20 people, including five separate Fleet homes, accounts and HTTPS
   hostnames running production Fleet web/settings/join/member paths. Each has a
   real local login and browser handoff. Agent lifecycle methods refuse and the
   actual fleet daemon is not started. The other fifteen use compiled shipped
   join/member clients, with explicitly harness-owned durable profile/journal
   persistence. Assert all connected, labelled administrator rows, exact use
   counts and refusal of the next attempt.
5. B-L12: repeat with 50 people and five real Fleet UI paths. Assert the Hub's
   actual push timestamps span under 60 seconds and all connect within five
   minutes without manual retry. To make queue presentation observable, the
   fixture deliberately delays real eligibility promises after shared-pool
   admission. It releases them after a visible real Hub backpressure/queue
   result, with a bounded fallback. No 429, permit or credential is fabricated.
   This controlled overload is separate from natural-host capacity evidence.
6. B-L13: a separate 50-person repetition with three simultaneous group joins.
   Then a source-bound cached old Hub HTML/shell/client/CSS capture uses the
   previous source's own HTML renderer and response CSP. Every substituted asset
   is hashed. A cached client must safely omit code management and show no raw
   translation keys or script errors.
7. B-L9: an actual previous-source v2 member client connects a code-issued Fleet;
   its code-notice target must remain `queued`. Close it and start the current
   compiled member on the same durable home; require delivery after upgrade.
8. Repeat a 50-person wave with revoke after 25 issues. Require counter 25, no
   later issue and retained issued Fleets. Scan the Hub home for code text and
   verify its audit chain. The runtime receipt records the real assertions.
9. Run the existing Hub UI and shell style gates serially. B-L10 then runs the
   existing previous/current source-Hub factory and full private backup/restore
   leg. This proves that source bootstrap boundary, not npm/systemd rollback.

One Chromium instance is shared. Five Fleet web services are kept only for the
current wave, then closed. The Node receipt's RSS includes Hub plus those Fleet
objects; it is labelled accordingly. Supervisor samples include child RSS/HWM,
container memory/peak/events, phase and time. Each wave records DB and WAL bytes,
use counts, start span and elapsed time. The overall receipt requires phase
success, runtime/rollback receipts, exact SHA and verified cleanup. OOM, timeout,
missing evidence and overlap fail the attempt.

## Preparation verification

- `bash -n` and `node --check` pass; esbuild parses all three `.mts` files without
  importing or executing them.
- Five pure interlock tests pass. Isolated GO/source/overlap/clock/window-bound
  reversals each fail intended assertions and restore exact bytes.
- Repository source and test typechecks pass, including the new interlock test.
  Those checks exclude manual `.mts` scripts, whose runtime imports and browser
  locators remain unexecuted. No claim of a runtime-ready or passing campaign is
  made until the authorized run.

Before publishing evidence, inspect every PNG and verify its source/hash receipt,
separate synthetic fixtures and version stamping from product/runtime claims,
and retain any failures. Re-sync and regenerate the GO plan if the candidate
changes. B1/B2 stay held for U2-first merge order and final parity review.
