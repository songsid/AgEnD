from pathlib import Path
import hashlib, json, os, subprocess

out = Path('.artifacts/model-switch-alpha/sync2-mutations')
out.mkdir(exist_ok=True)
path = Path('src/auth-api.ts')
original = path.read_text()
results = []
for name, before in [('A1-model-leaf', '"model-observation.js", '), ('A2-stale-leaf', '"stale-tab.js",')]:
    if os.getloadavg()[0] > 10:
        raise SystemExit('load above10; resume the remaining case later')
    assert original.count(before) == 1
    changed = original.replace(before, '')
    try:
        path.write_text(changed)
        types = subprocess.run(['./node_modules/.bin/tsc', '--noEmit', '--pretty', 'false'], capture_output=True, text=True)
        (out / (name + '-types.log')).write_text(types.stdout + types.stderr)
        assert types.returncode == 0, (name, 'invalid mutation')
        run = subprocess.run(['./node_modules/.bin/vitest', 'run', 'tests/web-app-modules-1408.test.ts', '-t', 'with no session:', '--maxWorkers=2'], capture_output=True, text=True)
        log = run.stdout + run.stderr
        (out / (name + '.log')).write_text(log)
        assert run.returncode != 0 and 'AssertionError' in log, (name, 'not a semantic red')
        results.append(dict(name=name, file=str(path), before=before, after='',
                            baseDigest=hashlib.sha256(original.encode()).hexdigest(),
                            mutantDigest=hashlib.sha256(changed.encode()).hexdigest(),
                            types=types.returncode, testExit=run.returncode, semanticRed=True,
                            scope='One selected actual anonymous static-closure test; unselected cases not counted'))
    finally:
        path.write_text(original)
        assert path.read_text() == original
    (out / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
    print(name + ' caught; exact source restored', flush=True)
