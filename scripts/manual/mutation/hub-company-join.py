"""Owned local assertion reversals for #3423. Each source is restored before the next mutant, including failure."""
from pathlib import Path
import json, subprocess, sys
ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / '.artifacts/hub-company-join/mutations'
OUT.mkdir(parents=True, exist_ok=True)
CASES = [
 ('browser-origin', 'src/hub/join/protocol.ts', 'input !== expected', 'false', 'tests/hub-company-join-protocol.test.ts', None),
 ('proof-purpose', 'src/hub/join/protocol.ts', 'p.purpose !== purpose || ', '', 'tests/hub-company-join-protocol.test.ts', None),
 ('receipt-owner', 'src/hub/join/receipt.ts', 'b.owner.realm, b.owner.objectId,', '"ignored", "ignored",', 'tests/hub-company-join-receipt.test.ts', None),
 ('receipt-deadline', 'src/hub/join/receipt.ts', 'now >= b.deliveryDeadline || ', '', 'tests/hub-company-join-receipt.test.ts', None),
 ('local-session', 'src/hub/join/local.ts', 'r.sessionId !== session.sessionId || ', '', 'tests/hub-company-join-local.test.ts', 'different cookie session'),
 ('journal-activation', 'src/hub/join/local-journal.ts', 'r.stage === "active" &&', 'true &&', 'tests/hub-company-join-local.test.ts', 'profile saved but membership'),
 ('crash-intent', 'src/hub/join/local.ts', 'if (sameSnapshot(r.snapshot, actual) ||', 'if (true || sameSnapshot(r.snapshot, actual) ||', 'tests/hub-company-join-local.test.ts', 'crash window'),
 ('retained-manual-quota', 'src/hub/enrollment-budget.ts', 'state.fleets.filter(f => f.status === "active" && f.credentialHash && personKeyString(f.owner) === key).length', '0', 'tests/hub-company-join-http.test.ts', 'retained manual Fleet consumes'),
 ('fresh-manual-eligibility', 'src/hub/join/service.ts', 'eligibility = await this.options.groups.prepareOwnerEligibility(owner, context);', 'eligibility = { assertCurrent() {} };', 'tests/hub-company-join-invitation.test.ts', 'lost directory eligibility after approval'),
 ('notice-v2-ack', 'src/hub/pairing-notices.ts', 'if (this.view(row).source === "manual" && !link.features.has("pairing-notices-v2"))', 'if (false)', 'tests/hub-pairing-notices.test.ts', 'manual v2 notice stays queued'),
 ('notice-v2-wire', 'src/hub/server.ts', 'if (frame.type === "pairing.notice-v2" &&', 'if (false && frame.type === "pairing.notice-v2" &&', 'tests/hub-pairing-notices-network.test.ts', 'manual notices use v2'),
 ('invitation-recipient', 'src/hub/join/service.ts', 'if (invitation && personKeyString(invitation.claims.owner) !== key)', 'if (false)', 'tests/hub-company-join-invitation.test.ts', 'copied invitation cannot select'),
 ('directory-epoch', 'src/hub/join/service.ts', '!this.options.current() || readHubSessionEpoch(this.options.db) !== this.directoryEpoch', '!this.options.current()', 'tests/hub-company-join-http.test.ts', 'directory epoch change'),
 ('browser-hosts', 'src/hub/join/protocol.ts', 'if (fleet.hostname === hub.hostname)', 'if (false)', 'tests/hub-company-join-protocol.test.ts', 'rejects shared browser hostnames'),
 ('issued-retention', 'src/hub/join/store.ts', "OR json_extract(body,'$.issuedHash') IS NOT NULL", "OR stage IN('issued','acknowledged')", 'tests/hub-company-join-http.test.ts', 'mixed legacy/company'),
 ('ancestor-durability', 'src/hub/join/private.ts', 'if (directory === ".") break;', 'break;', 'tests/hub-company-join-private.test.ts', None),
 ('pin-retry-durability', 'src/hub/join/trust.ts', 'syncJoinPrivate(this.home, suffix);', '', 'tests/hub-company-join-private.test.ts', 'pin left behind'),
 ('public-browser-hosts', 'src/ui/hub-company-join.js', 'separateHosts = u.hostname === new URL(location.origin).hostname;', 'separateHosts = false;', 'tests/hub-company-join-ui.test.ts', 'public link refuses'),
 ('visible-copy-attributes', 'tests/named-link-test-2906.test.ts', '.map(match => match[1] ?? match[2]).join(" ")', '.map(() => "").join("")', 'tests/named-link-test-2906.test.ts', 'keeps visible'),
]
if len(sys.argv) > 1:
    requested = set(sys.argv[1:])
    if requested - {case[0] for case in CASES}: raise RuntimeError('Unknown mutation name')
    CASES = [case for case in CASES if case[0] in requested]
results = []
for name, source, old, new, test, title in CASES:
    path = ROOT / source
    original = path.read_text()
    if old not in original:
        raise RuntimeError('Missing mutation anchor: ' + name)
    report = OUT / (name + '.json')
    try:
        path.write_text(original.replace(old, new))
        command = ['npx','vitest','run','--reporter=json','--outputFile=' + str(report),test]
        if title: command += ['-t', title]
        with (OUT / (name + '.log')).open('w') as log:
            run = subprocess.run(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
        data = json.loads(report.read_text())
        row = {'mutation':name,'failedTests':data['numFailedTests'],'totalTests':data['numTotalTests'],
               'caught':run.returncode != 0 and data['numFailedTests'] > 0 and not data.get('numRuntimeErrorTestSuites',0)}
        results.append(row)
        (OUT / ('results-delta.json' if len(sys.argv) > 1 else 'results.json')).write_text(json.dumps(results, indent=2))
        print(json.dumps(row), flush=True)
        if not row['caught']: raise RuntimeError('Mutation survived or did not reach assertions: ' + name)
    finally:
        path.write_text(original)
print('All mutation sources restored.', flush=True)
