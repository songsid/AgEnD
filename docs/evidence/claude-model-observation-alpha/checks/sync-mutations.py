from pathlib import Path
import hashlib, json, os, subprocess

out = Path('.artifacts/model-switch-alpha/sync-mutations')
out.mkdir(exist_ok=True)
path = Path('src/log-steps.ts')
original = path.read_text()
branch = 'if (found.at === null) return { records: out, truncated: true, end: from, ...(opts.end === undefined ? { skip: true as const } : {}) };'
cases = [
    ('S1-incoming-cursor', branch, 'if (found.at === null) return { records: out, truncated: true, end: 0 };'),
    ('S2-incoming-skip', branch, 'if (found.at === null) return { records: out, truncated: true, end: from };'),
    ('S3-startup-budget', 'readTailAtBoundary(path, fh, end, maxBytes - read, maxLines)', 'readTailAtBoundary(path, fh, end, maxBytes, maxLines)'),
]
results = []
for name, before, after in cases:
    if os.getloadavg()[0] > 10:
        raise SystemExit('load above10; resume the remaining isolated cases later')
    assert original.count(before) == 1, (name, 'non-unique target')
    changed = original.replace(before, after)
    try:
        path.write_text(changed)
        types = subprocess.run(['./node_modules/.bin/tsc', '--noEmit', '--pretty', 'false'], capture_output=True, text=True)
        (out / (name + '-types.log')).write_text(types.stdout + types.stderr)
        assert types.returncode == 0, (name, 'invalid mutation')
        run = subprocess.run(['./node_modules/.bin/vitest', 'run', 'tests/claude-model-checkpoint-tail.test.ts', '--maxWorkers=2'], capture_output=True, text=True)
        log = run.stdout + run.stderr
        (out / (name + '.log')).write_text(log)
        assert run.returncode != 0 and 'AssertionError' in log, (name, 'not a semantic red')
        results.append(dict(name=name, file=str(path), before=before, after=after,
                            baseDigest=hashlib.sha256(original.encode()).hexdigest(),
                            mutantDigest=hashlib.sha256(changed.encode()).hexdigest(),
                            types=types.returncode, testExit=run.returncode, semanticRed=True))
    finally:
        path.write_text(original)
        assert path.read_text() == original
    (out / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
    print(name + ' caught; exact source restored', flush=True)
