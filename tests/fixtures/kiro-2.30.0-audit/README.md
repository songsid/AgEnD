# kiro-cli 2.30.0 audit against 2.29.0 (2026-10-13, #1784)

The baseline is 2.29.0, the last audited release (`../kiro-2.29.0-audit/`).

## Artifacts

| | 2.29.0 | 2.30.0 |
|---|---|---|
| tarball `kirocli-x86_64-linux.tar.gz` sha256 (equals the release manifest's) | `5af5b6a30f7f557a24628b40a0a9f47a793429f5e58447ee99583ffa85dde768` | `df252365e8f8a3aa9ddf543060892c915af072b660a5527c0895351654b912f8` |
| `bin/kiro-cli-chat` sha256 | `c724b7ed1dcfae8086ceadca596ca3a870e06791a2778b2469832cfd19eb056c` | `488a7442186f1af48ea69c229f606ded2c53b45991918fa682a8fe2f3e65285f` |

- `../kiro-help/chat-help-2.30.0.txt` is `kiro-cli chat --help` from 2.30.0. It is byte-identical to 2.29.0's (sha256 `34f05faf…`), so the pinned flags have not changed.
- `kiro-cli-chat-2.30.0.prompts.txt` holds the three launch prompts' text, copied from the 2.30.0 binary.

## Static precheck (`precheck-2.29.0-2.30.0.txt`, run with main's manifest)

**MAJOR, hard=4.** The four missing literals are the 2.29 wording of the three prompts: 2.30.0 renamed "3.0" to "V3" and "2.0" to "V2".

The other two lines in the report are not detector changes:
- `ExpiredTokenException` dropped from 36 to 35 occurrences, but it is still present.
- The "new prompt-like string" is a neighbouring string in the string table. The detector's own literal, "Kiro rate limit reached:", is unchanged.

## Live: the Classic nudge on AgEnD's pinned legacy launch (`120-*`, `80-*`)

Same setup as 2.29.0: an isolated `HOME`/`XDG_*`, `unshare -rn`, a dummy token in the scratch `data.sqlite3`, and a private tmux socket.
- Launch: `kiro-cli chat --legacy-ui --agent-engine=v1 --trust-all-tools`. It was run with and without `--resume`, at 120 and 80 columns.
- Keys: chosen by the PATCHED `KiroBackend.getStartupDialogs()` reading the live pane, with the first active entry acting, as the daemon does.
- Compatibility: as the real binary reported it (`source: help`, engines `v2, v1, v3`).

The sequence:
1. `*-cursor-switch`: the cursor is on "Switch to V3 and upgrade my agent configs". AgEnD sent ONE `Down` (`kiro-classic-nudge-step`). On main, no entry matches this frame, and #1691's catch-all doesn't recognise it either.
2. `*-cursor-remind`: the cursor is on "Remind me later". AgEnD sent `Enter` (`kiro-classic-nudge-confirm`).
3. `120-answered`: the session went on as Classic and stopped only at the offline model fetch. The probe wrapper's own `PROBE-EXIT=` line was removed from this file.

Afterwards:
- The scratch store had `classicNudge.snoozeUntil` set 7 days ahead.
- The scratch `~/.kiro/settings/cli.json` was still `{}`.
- A 2.30.0 launch after that snooze, and a 2.30.0 launch after a 2.29.0 snooze, both showed no nudge.

## Not reachable offline

- **The V3 ease-in prompt** ("You're using Kiro CLI V2. Switch to V3 today.", options "Switch to V3 and upgrade my configs" / "Remind me later" / "Don't ask again"). It is gated by a rollout; `v3Prompt.snoozeUntil` and `v3Prompt.dismissed` record the answer.
- **The agent-config prompt** ("still in the V2 format", options "Enable auto-upgrade" / "Not now"). It appears only inside V3.

The test paints both from the binary's text in `kiro-cli-chat-2.30.0.prompts.txt`.

## Other launches

- `chat --tui --agent-engine=v2 --trust-all-tools` shows only the known trust confirmation, then the composer.
- `acp` answers `initialize` with clean JSON.
- `KIRO_CLASSIC_NUDGE_RELAUNCHED=1` does suppress the nudge, but it is kiro's internal marker for its own V3 relaunch, so AgEnD does not use it.
