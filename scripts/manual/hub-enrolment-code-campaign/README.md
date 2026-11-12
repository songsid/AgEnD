# Combined B1/B2/U2 campaign

Run only after the leader's explicit GO following the alpha.15 rehearsal.
U2/B1/B2 target alpha.16. First sync the landed dependencies and verify the exact
candidate. The template leaves `explicitGo` false. Preparation is separate from
the actual campaign receipt; it makes no runtime or browser acceptance claim.

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
label, removes its own labelled build-image tag and active marker. No automatic retry is present.

With host swap off, preflight and a one-second host sampler refuse load >=12
or MemAvailable below 4096 MiB. The sampler writes STOP for this attempt only;
the container supervisor then terminates its own child. Host readings are recorded
separately from container/child RSS. Check running containers before launch for
other heavy campaigns; any reported overlap requires STOP.

The launcher snapshots committed source only, refuses tracked modifications and
SHA drift, and requires both digest-pinned base images to be cached. It performs
no pull or package install. Pinned playwright-core1.64.0 must be prepared in
`CAMPAIGN_PW_DIR/node_modules/playwright-core` (default: private `.artifacts/
hub-enrolment-code-campaign-deps`); it is separately mounted read-only at /pw.
The preparation verifies the npm tarball SHA512. Its Docker config is private and empty. The single
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
   One code is created and reused across the eight capture contexts, then ended
   once; captures do not bypass the ten-creations/hour limit. U2's explicit read-only retry may be pressed up to3times on a failed prerequisite read; this is recorded, with no repeated writes. Four real scoped-refusal and four real ended-code views also cover EN/zh, desktop/phone, using two additional codes (eight creations total). Group suggestions
   use the committed synthetic LDAP wire's prefix/extensible
   filter support; there is no private fake-AD patch.
4. B-L11: 20 people, including five separate Fleet homes, accounts and HTTPS
   hostnames running production Fleet web/settings/join/member paths. Each has a
   real local login and browser handoff. Agent lifecycle methods refuse and the
   actual fleet daemon is not started. The other fifteen use compiled shipped
   join/member clients, with explicitly harness-owned durable profile/journal
   persistence. Assert all connected, labelled administrator rows, exact use
   counts and refusal of the next attempt.
5. B-L12: repeat with50 people and five real Fleet UI paths. Real AD sign-in
   (including five browser sessions) is completed before starting the connection
   burst and its time is included in wave elapsed. Assert actual push timestamps
   span under60 seconds and all connect within five minutes without manual retry.
   Harness machine exchanges have at most5 concurrent complete push/approve/redeem/ACK/connect flows, plus five real UI flows; this is a ramp
   within the specified60 seconds, not a50-at-once machine-RPC claim. Each wave also requires all links to be current together at its end. Existing
   five-second sign-in and machine deadlines stay unchanged.
6. B-L13: a separate50-person repetition with three group joins adds a deliberate
   overload control. Thirty-two separate fixture identities make actual shared-pool
   eligibility reads in groups of4. Each real LDAPS answer/close completes before
   its declared operation promise is held. User sign-in/approve calls are not
   held; they receive real pool backpressure immediately. The control releases
   after visible queue text, with a12-second fallback. Five real browsers reach their explicit consent buttons before pool filling; only then do they press together with the group and code client ramp. Group clients enter the ramp first, alongside the visible code joins. This avoids spending the controlled hold on browser setup. No HTTP429, permit,
   credential or directory answer is fabricated. This is a controlled queue
   proof, distinct from the natural B-L12 ramp. Real60-second quiet intervals
   between independent waves respect the120/min budget without resetting it.
   Then source-bound cached old Hub HTML/shell/client/CSS uses the previous
   renderer and CSP, with hashes of every substitution. A cached client must
   safely omit code management and show no raw keys or script errors.
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
- The original five pure interlock tests and GO/source/overlap/clock/window-bound
  reversals are historical preparation evidence. The swap-off host guards have
  their own focused tests and isolated reversals in the current acceptance.
- Repository source and test typechecks pass, including the new interlock test.
  Those checks exclude manual `.mts` scripts, whose runtime imports and browser
  locators remain unexecuted. No claim of a runtime-ready or passing campaign is
  made until the authorized run.

Before publishing evidence, inspect every PNG and verify its source/hash receipt,
separate synthetic fixtures and version stamping from product/runtime claims,
and retain any failures. Re-sync and regenerate the GO plan if the candidate
changes. B1/B2 stay held for U2-first merge order and final parity review.
