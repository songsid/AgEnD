#!/usr/bin/env python3
"""Runs only inside the runner's capped, networkless systemd container."""
import json, os, pathlib, pwd, shutil, subprocess, time, urllib.request
P = pathlib.Path
ROOT = P('/opt/rehearsal')
HOME = P('/home/rh')
DATA = HOME / 'oom/home'
PREFIX = ROOT / 'prefix'
PKG = PREFIX / 'lib/node_modules/@songsid/agend'
UNIT = 'com.agend.fleet.service'
receipt = {'revision': (ROOT/'revision').read_text().strip(), 'checks': [], 'legs': {}}
mock = None

def check(name, condition, details=None):
    receipt['checks'].append({'name': name, 'pass': bool(condition), 'details': details})
    (ROOT/'results.json').write_text(json.dumps(receipt, indent=2))
    print(('PASS ' if condition else 'FAIL ') + name, flush=True)
    if not condition: raise RuntimeError(name + ': ' + str(details))

def run(args, timeout=45, ok=True):
    p = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
    if ok and p.returncode: raise RuntimeError(str(args) + ': ' + p.stdout[-5000:])
    return p

def as_user(command, timeout=120, ok=True):
    env = f'export AGEND_HOME={DATA} npm_config_prefix={PREFIX} XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus PATH={PREFIX}/bin:/usr/local/bin:/usr/bin:/bin; '
    return run(['su', '-', 'rh', '-c', env + command], timeout, ok)

def sd(*args, ok=True):
    return as_user('systemctl --user ' + ' '.join(args), ok=ok)

def state():
    values = {}
    for line in sd('show', UNIT, '-p', 'MainPID,NRestarts,OOMPolicy,ControlGroup,MemoryMax,MemorySwapMax,ActiveState,Result,ExecMainCode,ExecMainStatus').stdout.splitlines():
        k, sep, v = line.partition('=')
        if sep: values[k] = v
    return values

def wait(name, fn, timeout=120):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            result = fn()
            if result: return result
        except (OSError, ValueError, urllib.error.URLError): pass
        time.sleep(.25)
    raise RuntimeError('Timed out: ' + name)

def http(path, data=None):
    request = urllib.request.Request('http://127.0.0.1:18443'+path,
        data=None if data is None else json.dumps(data).encode(), headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=3) as response: return json.load(response)

def calls():
    value = http('/control/calls')
    return value if isinstance(value, list) else value.get('result', value.get('calls', []))

def sibling_reply(label):
    http('/control/reset', {})
    http('/control/send-message', {'text': label, 'chat_id': -1001234567890, 'thread_id': 87, 'user_id': 111222333})
    def replied():
        return any(c.get('method') == 'sendMessage' and 'Mock sibling survived' in json.dumps(c) for c in calls())
    check(label, bool(wait(label, replied)))

def events(group):
    return {k: int(v) for k, v in (line.split() for line in (group/'memory.events').read_text().splitlines())}

def ready():
    s = state()
    if s.get('ActiveState') != 'active' or not int(s.get('MainPID', '0')): return None
    if not all((DATA/'instances'/n/'mock-cli.pid').exists() for n in ['general', 'sibling']): return None
    return s

def policy(value):
    drop = HOME / '.config/systemd/user' / (UNIT+'.d')
    drop.mkdir(parents=True, exist_ok=True)
    (drop/'zz-oom-rehearsal.conf').write_text('[Service]\nOOMPolicy='+value+'\nMemoryMax=640M\nMemorySwapMax=0\nEnvironment=AGEND_OOM_REHEARSAL=1\nEnvironment=MOCK_RESPONSE=Mock\\x20sibling\\x20survived\n')
    run(['chown', '-R', 'rh:rh', str(drop)])
    sd('daemon-reload')

def child_hog(label, expect_restart):
    # Reset drains the mock's disconnected long-poll resolvers; the reply
    # proves the current adapter/MCP route before injecting a destructive command.
    sibling_reply(label+' sibling ready before OOM')
    before = wait('ready before '+label, ready)
    group = P('/sys/fs/cgroup'+before['ControlGroup'])
    check(label+' effective inner cap', (group/'memory.max').read_text().strip() == '671088640', before)
    check(label+' single-victim oom group', (group/'memory.oom.group').read_text().strip() == '0')
    outer_before = events(P('/sys/fs/cgroup'))
    pids = {n: (DATA/'instances'/n/'mock-cli.pid').read_text().strip() for n in ['general', 'sibling']}
    (ROOT/'hog-exit.json').unlink(missing_ok=True)
    http('/control/send-message', {'text': '__OOM_CHILD__', 'chat_id': -1001234567890, 'thread_id': 42, 'user_id': 111222333})
    if expect_restart:
        after = wait('service restarted after '+label, lambda: (s if int((s:=state()).get('NRestarts','0')) > int(before['NRestarts']) and s.get('ActiveState') == 'active' else None))
        check(label+' whole-service restart reproduced', after['MainPID'] != before['MainPID'], after)
    else:
        death = wait('child OOM exit', lambda: json.loads((ROOT/'hog-exit.json').read_text()) if (ROOT/'hog-exit.json').exists() else None)
        check(label+' child died SIGKILL', death.get('signal') == 'SIGKILL', death)
        after = state()
        check(label+' fleet PID unchanged', after['MainPID'] == before['MainPID'], after)
        check(label+' restart count unchanged', after['NRestarts'] == before['NRestarts'])
        check(label+' mock CLI PIDs unchanged', pids == {n: (DATA/'instances'/n/'mock-cli.pid').read_text().strip() for n in pids})
        with urllib.request.urlopen('http://127.0.0.1:19280/health', timeout=3) as response: check(label+' health responds', response.status == 200)
        sibling_reply(label+' sibling replies')
    outer_after = events(P('/sys/fs/cgroup'))
    check(label+' actual cgroup OOM kill', outer_after['oom_kill'] > outer_before['oom_kill'], [outer_before, outer_after])
    receipt['legs'][label] = {'before': before, 'after': after, 'events_before': outer_before, 'events_after': outer_after}
    (ROOT/'results.json').write_text(json.dumps(receipt, indent=2))

try:
    check('Docker-only boundary', P('/.dockerenv').exists() and os.environ.get('AGEND_OOM_REHEARSAL') == '1')
    check('outer memory cap verified', (P('/sys/fs/cgroup/memory.max').read_text().strip()) == '1610612736')
    check('outer swap disabled', P('/sys/fs/cgroup/memory.swap.max').read_text().strip() == '0')
    check('systemd 249', run(['systemd','--version']).stdout.startswith('systemd 249'))
    check('test account uid', pwd.getpwnam('rh').pw_uid == 1000)
    run(['loginctl','enable-linger','rh']); run(['systemctl','start','user@1000.service'])
    wait('private user manager', lambda: P('/run/user/1000/systemd/private').exists())
    check('no existing fleet unit', sd('is-active', UNIT, ok=False).stdout.strip() not in ['active', 'activating'])
    PKG.parent.mkdir(parents=True, exist_ok=True); (PREFIX/'bin').mkdir(parents=True)
    shutil.move(str(ROOT/'pkg'), str(PKG))
    for name in ['agend', 'agend-install']:
        (PREFIX/'bin'/name).symlink_to(PKG/'launcher'/('agend' if name == 'agend' else 'agend-install.cjs'))
    # Only npm retrieval is inert. The target installer's verify/install/restart
    # and all unit files/manager reloads are real inside this container.
    npm = PREFIX/'bin/npm'
    npm.write_text('#!/bin/sh\nif [ "$1" = install ] && [ "$2" = -g ]; then echo "private candidate already materialized"; exit 0; fi\nexec /usr/local/bin/npm "$@"\n')
    npm.chmod(0o755)
    fixture = PKG/'e2e/mock-servers/mock-claude.mjs'
    source = fixture.read_text().replace('writeStatusline();\nconst statusTimer', 'writeFileSync(join(INSTANCE_DIR, "mock-cli.pid"), String(process.pid));\nwriteStatusline();\nconst statusTimer', 1)
    source = source.replace('  if (!trimmed) return;', '''  if (!trimmed) return;
  if (trimmed === "/quit") { mcpChild.kill("SIGTERM"); process.exit(0); }
  if (trimmed.includes("__OOM_CHILD__") || trimmed.includes("__OOM_MAIN__")) {
    const score = trimmed.includes("__OOM_CHILD__") ? "1000" : "0";
    const hog = spawn("python3", ["-c", "from pathlib import Path; import time; Path('/proc/self/oom_score_adj').write_text('" + score + "'); a=[]; exec(\\\"while True: a.append(bytearray(4*1024*1024)); time.sleep(.01)\\\")"], {stdio:"ignore"});
    hog.on("exit", (code, signal) => writeFileSync("/opt/rehearsal/hog-exit.json", JSON.stringify({pid:hog.pid, code, signal})));
    return;
  }''', 1)
    fixture.write_text(source)
    DATA.mkdir(parents=True)
    for name in ['general','sibling']: (HOME/'oom/work'/name).mkdir(parents=True)
    config = {'channel': {'type':'telegram','mode':'topic','bot_token_env':'AGEND_BOT_TOKEN','group_id':-1001234567890,
        'telegram_api_root':'http://127.0.0.1:18443','access':{'mode':'locked','allowed_users':[111222333]}},
        'defaults': {'backend':'mock','model':'mock-model','tool_set':'standard','hang_detector':{'enabled':False},
            'context_guardian':{'grace_period_ms':600000,'max_age_hours':0}},
        'instances': {n:{'working_directory':str(HOME/'oom/work'/n),'topic_id':topic} for n,topic in [('general',42),('sibling',87)]},
        'health_port':19280}
    (DATA/'fleet.yaml').write_text(json.dumps(config)); (DATA/'.env').write_text('AGEND_BOT_TOKEN=123456:rehearsal\n')
    (ROOT/'telegram-server.mjs').write_text("import {createTelegramMock} from './telegram-mock.mjs'; await createTelegramMock({port:18443}).start();\n")
    run(['chown','-R','rh:rh',str(ROOT),str(HOME/'oom')])
    as_user(f'node {PKG}/launcher/postinstall.cjs')
    check('candidate runs', as_user('agend --version').returncode == 0)
    mock = subprocess.Popen(['node', str(ROOT/'telegram-server.mjs')], stdout=open(ROOT/'telegram.log','w'), stderr=subprocess.STDOUT)
    wait('mock Telegram', lambda: http('/control/calls') is not None)
    check('fresh real install definition', as_user('agend install --no-activate').returncode == 0)
    policy('continue'); sd('start', UNIT)
    fresh = wait('fresh fleet ready', ready)
    check('fresh loaded OOMPolicy continue', fresh['OOMPolicy'] == 'continue', fresh)
    sibling_reply('fresh sibling replies')
    child_hog('continue', False)
    # Restart migration: absent key, no override; ask the actual CLI to refresh.
    unit_file = HOME/'.config/systemd/user'/UNIT
    sd('stop',UNIT)
    drop = HOME/'.config/systemd/user'/(UNIT+'.d')/'zz-oom-rehearsal.conf'
    drop.write_text(drop.read_text().replace('OOMPolicy=continue\n',''))
    unit_file.write_text('\n'.join(l for l in unit_file.read_text().splitlines() if not l.startswith('OOMPolicy='))+'\n')
    sd('daemon-reload'); check('legacy missing policy loads stop', state()['OOMPolicy'] == 'stop')
    restart = as_user('agend restart --yes', timeout=180)
    check('restart refresh loaded continue', wait('restart ready', ready)['OOMPolicy'] == 'continue', restart.stdout[-2000:])
    # Target-version updater path; package fetch is the local inert boundary.
    sd('stop', UNIT)
    unit_file.write_text('\n'.join(l for l in unit_file.read_text().splitlines() if not l.startswith('OOMPolicy='))+'\n')
    sd('daemon-reload')
    update = as_user('agend-install --upgrade', timeout=180)
    check('target installer refresh loaded continue', wait('update ready', ready)['OOMPolicy'] == 'continue', update.stdout[-2000:])
    policy('stop'); override = as_user('agend restart --yes', timeout=180); wait('stop control ready', ready)
    check('explicit override reported and preserved', state()['OOMPolicy'] == 'stop' and 'OOMPolicy=stop' in override.stdout, override.stdout[-2000:])
    child_hog('stop-control', True)
    policy('continue'); sd('restart', UNIT); before = wait('main control ready', ready)
    sibling_reply('main-control sibling ready before OOM')
    prior = events(P('/sys/fs/cgroup'))
    victim = P('/proc')/before['MainPID']
    check('main victim belongs to private fleet', str(PKG).encode() in (victim/'cmdline').read_bytes()
        and before['ControlGroup'] in (victim/'cgroup').read_text() and victim.stat().st_uid == 1000)
    (victim/'oom_score_adj').write_text('1000')
    http('/control/send-message', {'text': '__OOM_MAIN__', 'chat_id': -1001234567890, 'thread_id': 42, 'user_id': 111222333})
    after = wait('main OOM restart', lambda: (s if int((s:=state()).get('NRestarts','0')) > int(before['NRestarts']) and s.get('ActiveState') == 'active' else None))
    check('OOM main PID replaced by Restart policy', after['MainPID'] != before['MainPID'], [before,after])
    check('main control actual OOM kill', events(P('/sys/fs/cgroup'))['oom_kill'] > prior['oom_kill'])
    sibling_reply('after main OOM sibling replies')
    receipt['legs']['main-oom'] = {'before':before,'after':after}
    sd('stop', UNIT)
    tests = as_user(f'cd {PKG} && systemd-run --user --wait --pipe --collect --working-directory={PKG} --unit=oom-guard-tests -p MemoryMax=768M -p MemorySwapMax=0 -p CPUQuota=200% node node_modules/vitest/vitest.mjs run tests/session-oom-stop-2035.test.ts tests/oom-policy-loaded-2015.test.ts tests/child-stdio-errors-2374.test.ts --maxWorkers=1', timeout=90)
    (ROOT/'guard-tests.log').write_text(tests.stdout)
    check('real Daemon guard suites inside isolated container', tests.returncode == 0, tests.stdout[-3000:])
    receipt['guard_test_boundary'] = 'Actual Daemon decisions; fake proc/journal evidence. Nested-container PID attribution is deliberately unknown in production.'
    native = as_user(f'systemd-run --user --wait --pipe --collect --working-directory={PKG} --unit=oom-native-tests -p MemoryMax=512M -p MemorySwapMax=0 -p CPUQuota=200% node node_modules/vitest/vitest.mjs run --config vitest.config.integration.ts tests/tmux-manager.test.ts tests/tmux-control-native-1401.test.ts -t "creates and detects session|reuses one window id|respawns a process|matches window/pane reads" --maxWorkers=1', timeout=90)
    (ROOT/'native-tests.log').write_text(native.stdout)
    check('private native tmux pane PID contract', native.returncode == 0, native.stdout[-2000:])

finally:
    try:
        (ROOT/'telegram-calls.json').write_text(json.dumps(calls(), indent=2))
        (ROOT/'final-unit.json').write_text(json.dumps(state(), indent=2))
    except Exception: pass
    try:
        (ROOT/'journal.log').write_text(as_user('journalctl --user -u com.agend.fleet --no-pager -n 150', ok=False).stdout)
    except Exception: pass
    try: sd('stop', UNIT, ok=False)
    except Exception: pass
    if mock is not None:
        mock.terminate()
        try: mock.wait(timeout=5)
        except subprocess.TimeoutExpired: mock.kill(); mock.wait()
    (ROOT/'results.json').write_text(json.dumps(receipt, indent=2))
