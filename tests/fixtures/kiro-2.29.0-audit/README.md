# kiro-cli 2.29.0 audit against 2.28.0 (2026-10-11)

Baseline: 2.28.0, the release #1308 audited (its Classic nudge is answered "Remind me later").

## Artifacts

| | 2.28.0 | 2.29.0 |
|---|---|---|
| tarball `kirocli-x86_64-linux.tar.gz` sha256 (= the release index's) | `8343a15db789c24a906fc1eacb72734c7adc2d58cbe95f6e74a2ce750186058e` | `5af5b6a30f7f557a24628b40a0a9f47a793429f5e58447ee99583ffa85dde768` |
| `bin/kiro-cli-chat` sha256 | `ae5e172a905bd0078e9d2faded43837d05bd684615572af9917702fc349bbd4d` (the binary `kiro-2.28.0-classic-nudge/` was captured from) | `c724b7ed1dcfae8086ceadca596ca3a870e06791a2778b2469832cfd19eb056c` |
| BUILD_HASH | `877b466eda188c6dc44136df230f7e193a4edbfa` | `31e6bb3fad4a1fff9ba23aee436cef61c8579a58` |

`../kiro-help/chat-help-2.29.0.txt` is `kiro-cli chat --help` of 2.29.0, byte for byte (sha256 `34f05faf09a5eacb0df1fb81cbcb6ad8049e02f86f85f143288150a7da6dac39`). Against 2.28.0 the only change is where `-v, --verbose` is listed. The flags AgEnD pins are unchanged: `--legacy-ui`, `--tui`, `--v3`, `--agent-engine` with `[possible values: v2, v1, v3]`, `--resume-id` and `--agent`.

## Static precheck (`precheck-2.28.0-2.29.0.txt`)

The precheck is `scripts/manual/cli-upstream-precheck/precheck.py` from PR #1575 at `a73edc81`. Its verdict is **MINOR**. It found nothing missing, nothing new and no new prompt-like strings. One count changed: `kiro-cli login`, from 8 to 9. The new occurrence is in the help text of `kiro-cli acp --auth-method`, an option 2.28.0 already had ("Defaults to "cli", which uses the kiro-cli login session"). AgEnD does not run `kiro-cli acp`, so no detector surface changed.

## Live regression of #1308 (the files `120-*.pane.txt`)

The setup:
- An isolated `HOME`/`XDG_*` in scratch (never the host `~/.kiro`).
- `unshare -rn`, so there is no network.
- A dummy social token in the scratch `data.sqlite3`.
- A private tmux socket, 120×40.

The command was AgEnD's legacy launch, `kiro-cli chat --legacy-ui --agent-engine=v1 --trust-all-tools --resume`.

The keys were chosen by `KiroBackend.getStartupDialogs()` reading the live pane, with the first active entry acting, as the daemon does. It ran with the compatibility the real 2.29.0 binary reported (`source: help`, engines `v2, v1, v3`).

1. `120-cursor-switch.pane.txt`: the nudge, with the cursor on "Switch to 3.0 and upgrade my agent configs". AgEnD sent ONE `Down` (`kiro-classic-nudge-step`).
2. `120-cursor-remind.pane.txt`: the cursor is on "Remind me later". AgEnD sent `Enter` (`kiro-classic-nudge-confirm`).
3. `120-answered.pane.txt`: the description stays on screen and the options are gone. The session went on as Classic and stopped only at the offline model fetch (`dispatch failure`).

Afterwards, the scratch `data.sqlite3` had `state` `classicNudge.snoozeUntil = 2026-10-17T15:59:28.473802545Z`: the 7-day snooze. The scratch `~/.kiro/settings/cli.json` was still `{}`, with no `chat.agentEngine` written. The instance stays on the engine AgEnD pins. Both nudge frames are identical to 2.28.0's `120-cursor-switch` and `120-cursor-remind` once trailing blank rows are stripped.

## A machine-wide `chat.agentEngine=v3` does not stop AgEnD's pinned Classic launch (`v3-default/`)

Picking "Switch to 3.0" on the nudge in any kiro session saves `chat.agentEngine=v3` in `~/.kiro/settings/cli.json`, which applies to the whole machine. Since 2.28.0 the binary also has this refusal: "`<flag>` can't be used because Kiro CLI 3.0 is your default". The question was whether that refusal stops every AgEnD Classic instance on the machine.

The test set the scratch `cli.json` to `{"chat.agentEngine":"v3"}` and used the same isolation as above. Every run exited 1: offline, a session that continues stops at `dispatch failure`, and a refusal also exits 1. The two outcomes are told apart by their text.

| Launch (`kiro-cli chat …`) | 2.28.0 | 2.29.0 |
|---|---|---|
| AgEnD's `--legacy-ui --agent-engine=v1 --trust-all-tools --resume` | **Runs Classic.** The nudge appears, AgEnD answers "Remind me later", and the session continues as Classic (`2.28.0-pinned-legacy-{nudge,answered}`). | **Runs Classic.** It continues straight on with the nudge snoozed (`2.29.0-pinned-legacy-snoozed`); with the nudge showing, AgEnD answers it and the session continues (`2.29.0-pinned-legacy-{nudge,answered}`). |
| `--legacy-ui --trust-all-tools --resume` (no engine) | **Refused** (`2.28.0-legacy-ui-alone-refused`) | **Refused** (`2.29.0-legacy-ui-alone-refused`) |
| `--classic --trust-all-tools` (no engine) | | **Refused** (`2.29.0-classic-alone-refused`) |
| `--agent-engine=v1 --trust-all-tools` | | Runs Classic (`2.29.0-agent-engine-v1-alone`) |
| `--legacy-ui --agent-engine v1 --trust-all-tools` (space form) | | Runs Classic (`2.29.0-legacy-ui-agent-engine-space-v1`) |

The refusal applies only to the UI alias when no engine is given. An explicit `--agent-engine v1` still opens Classic, which is what the refusal itself suggests: "To open Classic once, run: kiro-cli chat --agent-engine v1". In both cases the scratch `cli.json` stayed `{"chat.agentEngine":"v3"}`: AgEnD's answer never touches it.

`planKiroLaunch` is the only code that builds a kiro launch, and it pairs `--legacy-ui` with `--agent-engine=v1` on every binary that has a v1 engine. It emits `--legacy-ui` alone only for binaries the version table proves have no engine choice (before 2.4). Those predate v3 and therefore this refusal.
