#!/usr/bin/env python3
"""Sequential, restoring focused mutations. Run with no browser/tests sharing this checkout's source."""
import json
from pathlib import Path
import re
import subprocess

root = Path(__file__).resolve().parents[3]
out = root / ".artifacts/quick-pairing/mutations"
out.mkdir(parents=True, exist_ok=True)
core = "tests/hub-quick-pairing.test.ts"
inbox = "tests/hub-pairing-inbox.test.ts"
notice = "tests/hub-pairing-notices.test.ts"


def replace(before, after):
    def change(text):
        assert text.count(before) == 1, before
        return text.replace(before, after)
    return change


def owner_bypass(text):
    start = text.index("  async revokeOwned(")
    before, method = text[:start], text[start:]
    assert method.count("personKeyString(f.owner) !== personKeyString(owner)") == 1
    assert method.count("personKeyString(f.owner) === personKeyString(owner)") == 1
    return before + method.replace("personKeyString(f.owner) === personKeyString(owner)", "true").replace("personKeyString(f.owner) !== personKeyString(owner)", "false")


def ack_before_retention(text):
    line = '      await link.send({ v: 1, type: "pairing.notice-ack", requestId: notice.id, linkEpoch: link.linkEpoch, payload: { id: notice.id } });'
    assert text.count(line) == 1
    return text.replace(line, "").replace("      options.db.transaction(() => {", line + "\n      options.db.transaction(() => {")


cases = [
    ("group-only-admission", "src/hub/pairing.ts", core, replace('if (permit.source !== "group" || permit.maxFleets < 1)', 'if (permit.maxFleets < 1)')),
    ("quota-at-limit", "src/hub/pairing.ts", core, replace('if (this.slots(state, owner) >= permit.maxFleets)', 'if (this.slots(state, owner) > permit.maxFleets)')),
    ("admin-headroom", "src/hub/pairing.ts", core, replace('if (state.pairings.length >= 48)', 'if (state.pairings.length >= 64)')),
    ("replace-one-offer", "src/hub/pairing.ts", core, replace('state.pairings = state.pairings.filter(p => !own.some(old => old.id === p.id));', 'state.pairings = state.pairings;')),
    ("fingerprint-check", "src/hub/pairing.ts", core, replace('p.expiresAt <= this.now() || p.fingerprint !== fingerprint || personKeyString(p.owner)', 'p.expiresAt <= this.now() || personKeyString(p.owner)')),
    ("skip-only-admin-wait", "src/hub/pairing.ts", core, replace('if (!p.ownerConfirmed || (!p.adminApproved && !p.automatic))', 'if (!p.ownerConfirmed || !p.adminApproved)')),
    ("negative-cancels-attempt", "src/hub/pairing.ts", core, replace('if (p.automatic && enrollmentRefusal.code === "denied") state.pairings = state.pairings.filter(row => row.id !== p.id);', '/* mutant retains a denied reservation */')),
    ("required-notice-queue", "src/hub/pairing.ts", core, replace('this.options.quick.enqueue(database,', '(() => undefined)(database,')),
    ("exact-owner-revoke", "src/hub/pairing.ts", core, owner_bypass),
    ("notice-session-privacy", "src/hub/pairing-notices.ts", notice, replace("WHERE t.kind='person' AND t.target=? AND n.initiating_session<>? ORDER BY", "WHERE (t.kind='person' AND t.target=? AND n.initiating_session<>?) OR 1=1 ORDER BY")),
    ("hub-history-reachable", "src/hub/pairing-notices.ts", notice, replace("ORDER BY n.rowid DESC LIMIT 1024", "ORDER BY n.rowid DESC LIMIT 100")),
    ("member-history-reachable", "src/hub/member/pairing-notices.ts", inbox, replace("ORDER BY rowid DESC LIMIT 1024", "ORDER BY rowid DESC LIMIT 100")),
    ("history-batch-progress", "src/ui/hub-quick-pairing.js", "tests/hub-quick-pairing-ui.test.ts", replace("setHistoryCount(n => n + 100)", "setHistoryCount(n => n)")),
    ("member-retains-before-ack", "src/hub/member/pairing-notices.ts", inbox, ack_before_retention),
    ("notice-capability-send", "src/hub/server.ts", "tests/hub-pairing-notices-network.test.ts", replace('    if (frame.type === "pairing.notice" && (!connection.context.features.has("pairing-notices-v1") || !connection.context.features.has("welcome-caps-v1"))) throw new HubProtocolError("incompatible");', '    /* mutant sends notice to older peer */')),
]
results = []
for name, filename, suite, mutate in cases:
    path = root / filename
    original = path.read_bytes()
    result_file = out / (name + ".json")
    try:
        path.write_text(mutate(original.decode()))
        run = subprocess.run(["npx", "vitest", "run", suite, "--reporter=json", "--outputFile=" + str(result_file)], cwd=root, capture_output=True, text=True)
        (out / (name + ".log")).write_text(run.stdout + run.stderr)
        report = json.loads(result_file.read_text()) if result_file.exists() else {}
        failures = [t["fullName"] for suite_result in report.get("testResults", []) for t in suite_result.get("assertionResults", []) if t["status"] == "failed"]
        killed = run.returncode != 0 and report.get("numTotalTests", 0) > 0 and report.get("numFailedTests", 0) > 0 and bool(failures)
        results.append({"name": name, "killed": killed, "total": report.get("numTotalTests", 0), "failed": failures})
        print(name, "KILLED" if killed else "SURVIVED/INVALID", flush=True)
    finally:
        path.write_bytes(original)
(out / "summary.json").write_text(json.dumps(results, indent=2))
assert len(results) == len(cases) and all(r["killed"] for r in results), "Every mutation must execute tests and fail assertions"
