#!/usr/bin/env bash
# Dialog surfaces on one codex version, each on its own launch, every step captured at 25 ms:
# folder trust (untrusted git dir; untrusted plain dir) → rate-limit picker with AgEnD's nudge flag removed
# (150x45 and 80x24) and its Escape → the sign-in screen (no provider override, no auth.json).
# Usage: AUDIT=… PORT=… pass2.sh <VERSION>
set -euo pipefail
V="${1:?version}"; R="$(cd "$(dirname "$0")" && pwd)/rig.sh"
r() { "$R" "$V" "$@"; }
r mock; r mode ok
WIN=trust r launch trust fresh untrusted "" 150x45 trustgit;     WIN=trust r cap 30-trust-git 8
WIN=plain r launch plain fresh untrusted "" 150x45 trustplain plain
WIN=plain r cap 31-trust-plain 8
WIN=picker r launch picker fresh trust nudge 150x45 pick;         WIN=picker r cap 32-picker-launch 6
r mode near; WIN=picker r send "hello";                           WIN=picker r cap 33-picker 8
WIN=picker r key Escape;                                          WIN=picker r cap 34-picker-escaped 4
r mode ok
WIN=pick80 r launch pick80 fresh trust nudge 80x24 pick80;        WIN=pick80 r cap 35-picker80-launch 6
r mode near; WIN=pick80 r send "hello";                           WIN=pick80 r cap 36-picker80 8
r mode ok
