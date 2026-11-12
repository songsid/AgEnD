#!/usr/bin/env python3
"""One owned, offline, 0.2-CPU container at a time; selected real HTTPS/LDAPS case only."""
import argparse, json, os, pathlib, shutil, subprocess, tempfile
p = argparse.ArgumentParser()
p.add_argument('--out', type=pathlib.Path, required=True)
p.add_argument('--test-source', type=pathlib.Path, help='Optional baseline test-file override')
a = p.parse_args()
repo = pathlib.Path(__file__).resolve().parents[3]
out = a.out.resolve(); out.mkdir(parents=True, exist_ok=True)
root = pathlib.Path(tempfile.mkdtemp(prefix='hub-3699-', dir=out))
name = 'agend-hub-3699-' + root.name.removeprefix('hub-3699-')
env = {**os.environ, 'DOCKER_CONFIG': str(root / 'docker')}
(root / 'docker').mkdir()
for f in ['package.json', 'vitest.config.ts', 'tsconfig.json', 'tsconfig.test.json']:
    shutil.copyfile(repo / f, root / f)
(root / '.artifacts').mkdir()
# Docker must own a real mountpoint, rather than follow this checkout's node_modules symlink.
(root / 'node_modules').mkdir()
image = 'node:22-bookworm'
subprocess.run(['docker', 'image', 'inspect', image], env=env, check=True, stdout=subprocess.DEVNULL)
command = ['docker', 'run', '--pull', 'never', '--rm', '--name', name, '--network', 'none', '--cpus', '0.2',
    '--memory', '768m', '--pids-limit', '128', '--read-only', '-u', f'{os.getuid()}:{os.getgid()}',
    '-e', 'HOME=/tmp', '--tmpfs', '/tmp:exec,size=256m,mode=1777',
    '--tmpfs', f'/w/node_modules/.vite:exec,uid={os.getuid()},gid={os.getgid()},size=128m',
    '--tmpfs', f'/w/node_modules/.vite-temp:exec,uid={os.getuid()},gid={os.getgid()},size=32m',
    '-v', f'{root}:/w', '-v', f'{repo / "src"}:/w/src:ro', '-v', f'{repo / "tests"}:/w/tests:ro',
    '-v', f'{repo / "launcher"}:/w/launcher:ro',
    '-v', f'{(repo / "node_modules").resolve()}:/w/node_modules:ro']
if a.test_source:
    command += ['-v', f'{a.test_source.resolve()}:/w/tests/hub-company-join-http.test.ts:ro']
command += ['-w', '/w', image, 'sh', '-c',
    'while :; do :; done & burner=$!; trap \'kill "$burner" 2>/dev/null; wait "$burner" 2>/dev/null\' EXIT; '
    'node node_modules/vitest/vitest.mjs run tests/hub-company-join-http.test.ts '
    '-t "the10min outer deadline" --maxWorkers=1; result=$?; exit "$result"']
(root / 'command.json').write_text(json.dumps(command, indent=2) + '\n')
try:
    with (out / 'pressure.log').open('w') as log:
        result = subprocess.run(command, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=240)
    (out / 'result.json').write_text(json.dumps({'exit': result.returncode, 'cpus': 0.2,
        'burners': 1, 'container': name, 'test': 'the10min outer deadline'}, indent=2) + '\n')
    raise SystemExit(result.returncode)
finally:
    subprocess.run(['docker', 'rm', '-f', name], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
