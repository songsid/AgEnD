# Muse 1.4.20-R8619.1: offline captures, 2026-11-14 (M-3113)

The daily upstream watch (which executes nothing) fetched the real binaries, and they were run directly. The `muse` launcher was never used, and the host's installed muse was never touched. Nothing reached a network or an account.

| Version | SHA256 | Bytes |
|---|---|---|
| 1.4.20-R8619.1 | `3685b023d45a1a07c8c559da00088bdf59564920b13a85adad11e13ad6f4d181` | 480565592 |
| 1.4.18-R8587.1 (captured the same way, the same day, as the control; not committed) | `57732db89e25a58196c923b3790aa3e2a85b8d1ad5094492384792260e65b538` | 485689688 |

## Rig

The rig is the same as for 1.4.15 (see `../muse-1.4.15/SOURCES.md`): [capture.sh](../../../scripts/manual/muse-version-audit/capture.sh) and [mock.py](../../../scripts/manual/muse-version-audit/mock.py).
- It runs in `docker run --network none --init --memory 2g --cpus 2 --pids-limit 256` (image `agend-rh-b16-bus-nobinfmt`), as uid 1000 owning `/home/u`.
- It uses a private `tmux -L audit` socket at 120×36 and a fresh HOME per scenario.
- Flags are AgEnD's production launch flags, and input is sent as AgEnD sends it.

## What the audit found

**No detector change.**
- All 45 captures of each version classify identically under the production `MuseBackend` predicates: ready, busy, startup and runtime dialogs, error patterns.
- The differences on screen are a decimal on short durations (`8.3s`), timestamps, hostnames and spinner glyphs.

**The precheck's hits** ("Trust and continue", "Resume this session; address it in Peer messages", "To continue this session, run" next to "usage limited") are in both binaries. Each sits in a reshuffled neighbour of a string table: the "new" hit is a new *neighbour*, not new text.
- The trust dialog, the resume line and the 402 usage-limit failure render the same on both versions (`first-run-trust-dialog`, `echo-quit`, `prod-usage-limit`).
- The "Muse Code" count change (585 → 541) is in the string tables. The idle header still reads `Muse Code 1.4.20`.

## Rig flake, not 1.4.20

In two full runs of `capture.sh` on 1.4.20, a different 1–3 screens came out blank:
- run 1: meta-idle, meta-done, prod-memory-write;
- run 2: prod-usage-limit.

The same screens rendered in the other run. To separate a slow or failed start from the rig:
- 55 timed launches per version (meta provider, production flags) painted the header in about 0.5 s on both, with no startup failure on either.
- Two launches were first counted as exits. The probe had matched its own typed command line, `echo EXITED=0`, before `clear` ran; 1.4.18 showed the same.

The committed set is run 1, with the three blank screens taken from run 2. It classifies identically to the 1.4.18 control.
