# Muse 1.4.24-R9131.1 — isolated audit (M-3396)

## Provenance and isolation

| Version | Bytes | SHA256 |
|---|---:|---|
| 1.4.24-R9131.1 | 471370072 | d752c45dce079ee29e118804b091d81ac2b1b89b67f317b4a162fa1af1206465 |
| 1.4.23-R8977.1 control | 466999640 | 7ca9e16659f759eab3ae6c4b61c6f1e70f5f3fea1ca961ebd49044a1146956f4 |

Both binaries came from the official version-pinned Muse manifest/download,
through the existing upstream-watch download command. The old hash agrees with
the 1.4.23 audit. Neither binary is committed. The installed Muse launcher,
account and configuration were never used.

The saved `rig/` runs the real binaries directly in bwrap --unshare-all, including
private network/PID/user/UTS namespaces, a scratch HOME per case and an isolated
`tmux -S /tmp/muse-m3396.sock -f /dev/null`. Only OS runtime files, the read-only
binary/harness and the owned output directory are mounted. Loopback is solely the
local Meta-provider mock. Fake API key, no credentials/provider quota. Commands
inherit nice 10 and low-priority I/O scheduling (best-effort class 2, priority 7).
No live/default tmux access, no recursive state-directory scan.

Run from a disposable directory (existing files are not removed):

```sh
mkdir -p /owned/output
bash rig/run.sh /owned/binary /owned/output
```

`rig/run.sh` resolves its harness under an audit layout containing `rig/` beside
its binary imports; pass the actual retained binary and output paths explicitly.
`AUDIT_PHASE=main|untrusted|rates` continues only those remaining scenario groups;
`WIDTHS=80` limits a targeted rate retake. These switches do not retry an action.

## Actual captures and verdict

24 new pane captures: 22 scenario frames plus two inter-retry frames; 22 freshly
captured 1.4.23 controls are under `control/`. New and control missing-session
stdout/stderr/exit files are direct process output: a fast error restores the
alternate screen before a dead-pane screenshot, so no artificial pane was made.
Version output confirms the exact new build.

**No detector change.**

- Ready/header and empty composer, busy/cancelled draft, quit/resume and missing
  session retain the existing contract. `Muse Code` count 165 → 164 is not a
  changed header: the actual header is `Muse Code 1.4.24`.
- Workspace trust and logged-out menus remain handled/held as before. Both
  escalated and untrusted active approval screens retain their human-only
  identity and no automated keys. The staged `keys active in a moment` screen is
  busy/non-idle until its actual active prompt appears.
- On both versions, mocked 429 retries classify as rate_limit/failover and their
  final error after **10 provider attempts** remains rate_limit/failover. Mocked
  402 is quota/notify, never rate-limit. Both 120 and 80 columns are captured.
- The new inter-retry row can show `rate limited (HTTP 429) · attempt …` without
  `retrying`; it still has Thinking chrome and is busy/non-idle. It is explicitly
  not a completed failure. Completed text can wrap at 80 columns.
- Normal post-answer Double checking is timing-dependent; paired after-answer
  frames are not claimed to be the identical animation instant. No approval,
  draft or error assertion is weakened to match that timing difference.

The precheck (kept in docs/evidence) reproduces MAJOR, hard=1, hinted=0, with no
missing literals. Its new pooled string is `rate limited retry  error  - To
continue this session, run …`. In the new binary `rate limited retry` begins at
byte 5139903; neighbouring labels include request failed, usage limit reached,
authentication failed, configuration error and server error. No native capture
prints that entire pooled string as a single dialog. The existing rate detector
already recognises `rate limited retry`; that specific assertion is a **source
control**, not a fabricated live frame. `rate_limit` count 30 → 31 and the changed
permission neighbours do not change observed error or permission decisions.

Only the changed/error/ready/permission/lifecycle surfaces above were re-probed.
The older memory/workflow/computer-use matrices were not repeated or claimed as
new 1.4.24 captures. This is an offline mock-provider audit, not a signed-in Muse
service compatibility claim; a real account call would require permission.

## Harness findings retained honestly

Early control runs exposed fast-exit alternate-screen loss, an over-specific
idle status expectation, and an approval key sent during the staged key gate.
The controller now retains direct fast-error output, recognises the actual model
status, and waits for the active prompt before pressing the synthetic test's 1.
Completed earlier controls were reused; no failing/blank frame is in the fixture
set. Initial rate completion detection also matched an inter-retry frame; those
are retained under `rate-between-retries-*`, and only the affected rate cases
were re-run to the explicit `model failed:` row. The final regression initially
failed two width assertions because it expected an unwrapped sentence; a
whitespace-tolerant assertion preserves the ten-attempt requirement.

The isolated environment may show `system SSH configuration projection omitted`
in the status row because host SSH configuration was not mounted; this is not a
real-host error and no host SSH file was read. The normal status row returns on
subsequent redraw. Existing detectors classify the captured idle row correctly.
