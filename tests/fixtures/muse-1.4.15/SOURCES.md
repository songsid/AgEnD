# Muse 1.4.15-R8339.1 — offline captures, 2026-11-10

The real binary was fetched by the daily upstream watch (which executes nothing) and run directly. The `muse` launcher was never used, the host's installed muse (1.4.14) was never touched, and no live AgEnD pane was involved.

| Version | SHA256 | Bytes |
|---|---|---|
| 1.4.15-R8339.1 | `abe0a72878c62b570c6eed6c17c5fc3c520a990ecf040511741c00092312a3d5` | 469588312 |
| 1.4.14-R7309.1 (the committed `muse-1.4.14` set, plus the `tip-*-on-1.4.14` captures here) | `0809aac7cb58d18f5022b6d05e02aa1974683c0ec430e5f04d25b60ed17de2da` | 414927192 |

## Rig

As for 1.4.14 (see `../muse-1.4.14/SOURCES.md`): [capture.sh](../../../scripts/manual/muse-version-audit/capture.sh) and the logging Responses mock [mock.py](../../../scripts/manual/muse-version-audit/mock.py) run in one disposable container.

- **Container:** `docker run --network none --init --memory 2g --cpus 2 --pids-limit 256` from image `agend-rh-b16-bus-nobinfmt` (node 22, tmux, python3), with its entrypoint overridden.
- **User:** the image's uid 1000 (`rh`), owning `/home/u`.
- **tmux:** a private `tmux -L audit` socket at 120×36.
- **Per scenario:** a fresh HOME.
- **Flags:** AgEnD's production launch flags, `--disable-approval --trust-workspace`.
- **Input:** sent as AgEnD sends it, `paste-buffer -p` then Enter.

## Captures

The 1.4.14 set (echo-*, resume-missing, first-run-trust-dialog, logged-out, meta-*, prod-*, approval-*, orphan-*) was re-captured with the same procedure.

| Capture | Procedure |
|---|---|
| echo-done | the 6 s frame of the main echo run, caught inside the post-turn `◈ Double checking (Ns · esc to interrupt)` phase |
| echo-double-checking / echo-done-later | a separate echo turn, at 10 s (still in the phase) and 15 s (phase ended) after the reply |
| prod-memory-write / prod-memory-project / prod-memory-personal | mock tool `add_memory`, scope default / `project` / `personal`, production flags |
| approval-memory-write (+ -after-esc, -after-enter) / approval-memory-project / approval-memory-personal | the same with `--trust-workspace` only (approval on, "Auto-review"); Escape / Enter |
| approval-memory-untrusted | `--trust-workspace --approval-mode untrusted` |
| prod-memory-edit | mock tool `edit_memory` on a missing file, production flags |
| tip-side-chat / tip-resume / tip-effort | the mock answers the post-turn tip picker with that tip id; capture 14 s after the turn |
| tip-*-on-1.4.14 | the same three runs with 1.4.14-R7309.1, as the "before" for the tip finding |

## What changed in 1.4.15, and what AgEnD does

- **The escalated command approval has a third option (#3588).**
  - The new option, `2. Always allow outside the sandbox in this workspace: <cmd> (p)`, sits before `3. No, and tell Muse Code what to do differently (esc)`.
  - AgEnD only recognised the two-option shape, so with approvals on (`skip_permissions: false`) the prompt was no longer held. It is recognised now.
  - The default launch is unaffected: `prod-escalation-denied` is unchanged.
- **New text "Would you like to allow this memory write?"**
  - It joins the approval family 1.4.14 already had (command / network / file / tool action).
  - It did not appear in any memory capture: every scope saved directly under the production flags, under Auto-review and under `--approval-mode untrusted`.
  - It is not reachable under AgEnD's launch (approval ceiling `allow_all`).
- **New text "usage limit is reached ("** is the voice-dictation message ("dictation stopped: the subscription's usage limit is reached (…)"), not a turn error.
- **The `/name` help text "Resume this session; address it in Peer messages."** was already in 1.4.14; only its neighbouring strings moved.
- **1.4.15 answers a bare greeting ("hello") without calling the provider.** A real prompt reaches it (the mock logs every request). The audit prompts avoid greetings.

## Already in 1.4.14 (not a 1.4.15 change)

- **The post-turn feature tip (#3588).**
  - After a turn, muse asks the model to pick one tip from a 23-entry catalog and draws it in the empty composer.
  - AgEnD knew 9 of them. A slash-command or key tip (`/side …`, `/resume …`, `/effort …`, `Ctrl+B …`) read as a typed draft, so the pane never proved idle. The `tip-*-on-1.4.14` captures show the same on 1.4.14.
  - The full catalog (every string exactly once in both binaries) is now an empty composer.
- **`◈ Double checking (Ns · esc to interrupt)`** (also in the 1.4.14 binary) is a short post-turn phase. It reads as busy while shown, and the pane is idle about 15 s after the turn.
