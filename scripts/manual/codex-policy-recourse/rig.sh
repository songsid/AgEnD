#!/usr/bin/env bash
set -euo pipefail
# Run inside an isolated network namespace: no provider/account network, only this loopback mock.
# Install0.169 into $AUDIT/codex-0.169.0 beforehand; do not use the host package.
: "${AUDIT:?set AUDIT to an owned scratch root with codex-0.169.0 installed}"
if [ "${1:-}" != --inside ]; then exec unshare -rn bash "$0" --inside; fi
ip link set lo up
export AUDIT PORT=18762 WIN=main
r() { scripts/manual/codex-version-audit/rig.sh 0.169.0 "$@"; }
trap 'r stop' EXIT
r mock
r launch main fresh trust
r cap startup 8
r mode cyber-recourse
r send 'Inert local audit of the refusal menu.'
r cap cyber-recourse 8
r launch main fresh trust '' 80x24
r cap narrow-startup 5
r mode bio-recourse
r send 'Inert local audit of the refusal menu.'
r cap bio-recourse-narrow 8

# No choice/retry is sent. The request count is recorded (the CLI may prewarm as well as generate).
node - "$AUDIT/run-01690/mock.log" <<'JS'
const {readFileSync}=require("node:fs");
const rows=readFileSync(process.argv[2],"utf8").split("\n").filter(s=>s.includes("POST /v1/responses "));
console.log(JSON.stringify({providerRequests:rows.length, inputTurns:2, keysAfterRefusal:0}));
JS
