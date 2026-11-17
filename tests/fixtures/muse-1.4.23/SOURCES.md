# Muse 1.4.23-R8977.1: offline captures, 2026-11-17 (M-3290)

The daily upstream watch (which executes nothing) fetched the real binaries, and they were run directly. The `muse` launcher was never used, the host's installed muse was never touched, and no muse account or quota was used: every request went to the local mock. Nothing reached a network or an account.

| Version | SHA256 | Bytes |
|---|---|---|
| 1.4.23-R8977.1 | `7ca9e16659f759eab3ae6c4b61c6f1e70f5f3fea1ca961ebd49044a1146956f4` | 466999640 |
| 1.4.20-R8619.1 (captured the same way, in the same run, as the control; not committed — the audited 1.4.20 set is `../muse-1.4.20`) | `3685b023d45a1a07c8c559da00088bdf59564920b13a85adad11e13ad6f4d181` | 480565592 |

## Rig

The rig is the same as for 1.4.20 (see `../muse-1.4.20/SOURCES.md`): [capture.sh](../../../scripts/manual/muse-version-audit/capture.sh), [mock.py](../../../scripts/manual/muse-version-audit/mock.py) and [switch.sh](../../../scripts/manual/muse-version-audit/switch.sh).
- One disposable container per version: `docker run --network none --init --memory 2g --cpus 2 --pids-limit 256` (image `agend-rh-b16-bus-nobinfmt`), as uid 1000 owning `/home/u`, the binary mounted read-only.
- A private `tmux -L audit` socket at 120×36 and a fresh HOME per scenario.
- AgEnD's production launch flags, and input sent as AgEnD sends it.
- New for 1.4.23 in `capture.sh`: the quit menu with local work still running (`prod-background-work`, `prod-quit-with-local-work`, `quit-menu-cursor2`, `quit-menu-after-esc`): a background `sleep 300`, `/quit`, Down once, Escape — never "Exit anyway". The precheck saw the menu's hint literal (`Enter to confirm · Esc to cancel`) change count, and the last live capture of that menu was 1.4.11's.
- `switch.sh`'s screens are in `../muse-1420-model-switch/1.4.23-*` with the switch run's mock requests.

## What the audit found

**No detector change.**
- All 48 screens captured on both versions in the same run classify identically under the production `MuseBackend` predicates: ready, busy, background work, idle, the draft, runtime and startup dialogs, error patterns, the approval identity, the quit menu and the resume-missing line. The 45 screens shared with the committed 1.4.20 set do too.
- The differences on screen are the version in the header (`Muse Code 1.4.23`), timestamps, durations, session ids and spinner glyphs.
- The quit menu reads the same on both versions and on 1.4.11's capture: held, never answered with Enter; after Escape the composer is idle with the task still running.
- The model and effort switch (`MUSE_RUNTIME_SWITCH`) reads the same: `Model set to … for this session (saved model unchanged)`, the footer row, the `unsupported reasoning effort` refusal, and the next turn's request carrying the switched model and effort.

**The precheck's hits:**
- "Yes, and don't ask again for this command in this session", "Allow this" (1 → 2), "Log in with browser" (1 → 2) and "Set an API key" (1 → 2): the second copies sit in a new list of the plugin API's reserved names (the labels a user plugin can't take: "Approve", "Reject", "Allow once", "Always allow this MCP tool", "Allow this stage once", …), not on a screen. "Yes, and don't ask again for this command in this session" was already in 1.4.20. The approval prompts still offer the same options (`approval-escalated`, `approval-untrusted-staged`), and the logged-out menu is unchanged.
- "resume the intended session and retry" and "source session has no stable side-chat point; wait for …": refusals of `/fork` and `/side`, which AgEnD never sends.
- "Computer Use now has its own Accessibility and Screen Recording permissions": a macOS notice for Computer Use.
- "Muse Code" 541 → 165, "rate_limit" 32 → 30, "to cancel" / "to select" and "ENOENT": string-table counts. The idle header still reads `Muse Code 1.4.23`, and the 429 / 402 screens classify as before.

## Rig flake, not 1.4.23

In this run one 1.4.20 control screen came out blank (`prod-memory-personal`), as in the 1.4.20 audit's own runs (a different 1–3 blank screens per run). No 1.4.23 screen was blank.
