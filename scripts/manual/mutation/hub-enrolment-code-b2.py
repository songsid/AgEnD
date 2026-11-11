"""Owned source reversals, one at a time; syntax valid, semantic assertion red, byte-exact restoration."""
from pathlib import Path
import hashlib, json, subprocess, sys

root = Path.cwd()
out = root / '.artifacts/hub-enrolment-code-b2/mutations'
out.mkdir(parents=True, exist_ok=True)
queue = 'src/ui/hub-join-queue.js'
ui = 'src/ui/hub-enrolment-code.js'
qtest = 'tests/hub-join-queue-b2.test.ts'
utest = 'tests/hub-enrolment-code-ui-b2.test.ts'
cases = [
    ('single-flight', queue, 'if (flight) return flight.promise;', '', qtest, 'concurrent presses'),
    ('retry-bound', queue, 'mine.attempts >= 9', 'mine.attempts >= 8', qtest, 'limits automatic retries'),
    ('jitter-floor', queue, 'delay = 2000 +', 'delay = 1000 +', qtest, 'backpressure queues'),
    ('live-owner', queue, '!stopped && current() === true', '!stopped', qtest, 'rechecks current after'),
    ('hard-deadline', queue, 'mine.deadlineTimer = setTimeout(() => finish(mine, timedOut(), "uncertain"), deadline - now());', '', qtest, 'never-settled approval'),
    ('honest-deadline', queue, '({ ok: false, code: "unavailable", deadline: true })', '({ ok: false, code: "expired", deadline: true })', qtest, 'already expired outer'),
    ('semantic-refusal', queue, '(answer.reason === undefined || answer.reason === "backpressure")', 'true', qtest, 'preserves an explicit limit'),
    ('maximum-input', ui, 'integer(max, 200)', 'true', utest, 'invalid maximum'),
    ('group-resolve', ui, '(scope === "directory" || group)', 'true', utest, 'resolves the selected DN'),
    ('ended-code', ui, 'row.state === "live" && row.code ? html`<code', 'row.code ? html`<code', utest, 'never renders or copies'),
    ('read-owner', ui, 'if (!current(mine) || writing.current) return;', 'if (writing.current) return;', utest, 'held old read'),
    ('uncertain-write', ui, 'else setNotice(errorText(r, kind === "create" ? "createFailed" : "endFailed"));', 'else setError(errorText(r, kind === "create" ? "createFailed" : "endFailed"));', utest, 'uncertain write'),
    ('code-notice-label', 'src/ui/hub-quick-pairing.js', 'notice.source === "code" ? he("byCode")', 'false ? he("byCode")', utest, 'code notice states'),
    ('notice-default-version', 'src/ui/hub-client.js', 'pairingNotices(version = 2)', 'pairingNotices(version = 3)', 'tests/hub-enrolment-code-client-b2.test.ts', 'code-aware notices'),
    ('page-queue', 'src/ui/hub-company-join.js', 'const r = await approval.run(session.csrf);', 'const r = await approveCompanyJoin(requestId, session.csrf);', 'tests/hub-join-approval-ui-b2.test.ts', 'shows the queue'),
    ('signin-queue', 'src/ui/panel-hub.js', 'const joined = await approval.run(r.csrf);', 'const joined = await approveCompanyJoin(company.requestId, r.csrf);', 'tests/hub-join-approval-ui-b2.test.ts', 'approval after company sign-in'),
    ('lease-retirement', 'src/ui/hub-join-approval.js', 'epoch.current++; holder.current?.queue.cancel(); holder.current = null;', 'epoch.current++; holder.current = null;', 'tests/hub-join-approval-ui-b2.test.ts', 'retiring the page'),
]
results = []
for name, relative, old, new, test, pattern in cases:
    if len(sys.argv) > 1 and name not in sys.argv[1:]:
        continue
    path = root / relative
    original = path.read_bytes()
    source = original.decode()
    assert source.count(old) == 1, (name, source.count(old))
    try:
        path.write_text(source.replace(old, new))
        syntax = subprocess.run(['node', '--check', relative], capture_output=True, text=True)
        assert syntax.returncode == 0, syntax.stderr
        run = subprocess.run(['node_modules/.bin/vitest', 'run', test, '-t', pattern, '--maxWorkers=1'], capture_output=True, text=True, timeout=45)
        log = run.stdout + run.stderr
        (out / (name + '.log')).write_text(log)
        caught = run.returncode != 0 and 'AssertionError:' in log and 'Test timed out' not in log and 'Failed Suites' not in log
        results.append({'guard': name, 'syntax': 'pass', 'assertionCaught': caught, 'exit': run.returncode})
        print(name, 'assertion red' if caught else 'NOT CAUGHT', flush=True)
    finally:
        path.write_bytes(original)
        assert hashlib.sha256(path.read_bytes()).digest() == hashlib.sha256(original).digest()
(out / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
assert results and all(row['assertionCaught'] for row in results), results
