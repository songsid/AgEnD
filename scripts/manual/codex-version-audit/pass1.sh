#!/usr/bin/env bash
# The turn sequence on one codex (production config, trusted git work dir), every step captured at 25 ms:
# launch → ok turn → slow turn (busy) → near-limit turn (nudge hidden by AgEnD) → usage limit → 401 → 500 → capacity →
# /compact with args → quit → production resume of the same thread → app-server killed (reconnect panes).
# Usage: AUDIT=… PORT=… pass1.sh <VERSION>
set -euo pipefail
V="${1:?version}"; R="$(cd "$(dirname "$0")" && pwd)/rig.sh"
export WIN=main
r() { "$R" "$V" "$@"; }
r mock
r launch main fresh trust;            r cap 01-launch 8
r mode ok;   r send "hello";          r cap 02-turn-ok 5
r mode slow; r send "again";          r cap 03-turn-slow 12
r mode near; r send "third";          r cap 04-near-limit 6
r mode usage; r send "fourth";        r cap 05-usage-limit 6
r mode e401; r send "fifth";          r cap 06-e401 10
r mode e500; r send "sixth";          r cap 07-e500 40
r mode capacity; r send "seventh";    r cap 08-capacity 40
r mode ok;   r send "/compact keep the decisions"; r cap 09-compact-args 8
r key C-c; sleep 0.5; r key C-c;      r cap 10-quit 4
r launch main resume trust;           r cap 11-resume 10
r mode ok;   r send "after resume";   r cap 12-turn-after-resume 5
r kill;                               r cap 13-app-server-killed 75
