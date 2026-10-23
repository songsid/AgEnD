#!/usr/bin/env python3
"""Private packaged stage-3 rehearsal. Never execute on a host."""
import json, os, pathlib, pwd, shlex, shutil, sqlite3, subprocess, time, urllib.request
P = pathlib.Path
ROOT, HOME = P('/opt/rehearsal'), P('/home/rh')
DATA, PREFIX = HOME/'working-recovery/home', ROOT/'prefix'
PKG, UNIT = PREFIX/'lib/node_modules/@songsid/agend', 'com.agend.fleet.service'
receipt = {'revision': (ROOT/'revision').read_text().strip(), 'checks': [], 'legs': {},
           'scope': 'Stage 3 task-only coordinator; legacy #1209/#926 turn ownership remains unchanged.'}
mock, active_leg, cursors = None, None, {}

def check(name, value, details=None):
    receipt['checks'].append({'name': name, 'pass': bool(value), 'details': details})
    (ROOT/'results.json').write_text(json.dumps(receipt, indent=2))
    print(('PASS ' if value else 'FAIL ')+name, flush=True)
    if not value: raise RuntimeError(name+': '+str(details))

def run(args, timeout=60, ok=True):
    p = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
    if ok and p.returncode: raise RuntimeError(str(args)+': '+p.stdout[-4000:])
    return p

def user(command, timeout=120, ok=True):
    env = f'export AGEND_HOME={DATA} npm_config_prefix={PREFIX} XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus PATH={PREFIX}/bin:/usr/local/bin:/usr/bin:/bin; '
    return run(['su', '-', 'rh', '-c', env+command], timeout, ok)

def sd(*args, ok=True): return user('systemctl --user '+' '.join(args), timeout=150, ok=ok)
def state():
    return dict(line.split('=', 1) for line in sd('show', UNIT, '-p',
        'MainPID,NRestarts,ActiveState,Result,ControlGroup,OOMPolicy,MemoryMax,MemorySwapMax,Type,NotifyAccess').stdout.splitlines() if '=' in line)

def wait(name, fn, timeout=180):
    until = time.monotonic()+timeout
    while time.monotonic() < until:
        try:
            result = fn()
            if result: return result
        except (OSError, ValueError, sqlite3.Error, urllib.error.URLError): pass
        time.sleep(.25)
    raise RuntimeError('Timed out: '+name)

def http(path, data=None):
    req = urllib.request.Request('http://127.0.0.1:18443'+path, data=None if data is None else json.dumps(data).encode(),
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=3) as response: return json.load(response)

def calls():
    data = http('/control/calls')
    return data if isinstance(data, list) else data.get('result', data.get('calls', []))

def sibling_reply(label):
    http('/control/reset', {})
    http('/control/send-message', {'text': label, 'chat_id': -1001234567890, 'thread_id': 87, 'user_id': 111222333})
    def replied():
        return next((c for c in calls() if c.get('method') == 'sendMessage' and str(c.get('params', {}).get('message_thread_id')) == '87'
            and 'Mock sibling survived' in str(c.get('params', {}).get('text', ''))), None)
    reply = wait(label, replied)
    check(label, bool(reply), reply)

def lines(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line] if path.exists() else []
def inputs(): return lines(ROOT/'physical-input.jsonl')
def timeline(): return lines(ROOT/'timeline.jsonl')
def query(file, sql, args=()):
    with sqlite3.connect(f'file:{DATA/file}?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        return [dict(row) for row in db.execute(sql, args)]
def card():
    rows = query('scheduler.db', "SELECT *,id AS uuid FROM tasks WHERE assignee='worker' ORDER BY updated_at DESC LIMIT 1")
    return rows[0] if rows else None
def observed():
    rows = query('delivery-outbox.db', "SELECT current_json FROM working_state_journal WHERE instance_name='worker'")
    return json.loads(rows[0]['current_json']) if rows else None
def ready():
    s = state()
    if s.get('ActiveState') != 'active' or not any(t['event'] == 'final-ready' and t['pid'] == int(s.get('MainPID', '0')) for t in timeline()): return None
    if not all((DATA/'instances'/n/'mock-cli.pid').exists() for n in ['general', 'worker', 'sibling']): return None
    return s

def tool(args):
    path = DATA/'instances/worker/mock-control.json'
    path.write_text(json.dumps({'call_tool': {'name': 'task', 'args': args}})); run(['chown', 'rh:rh', str(path)])

def seed_or_update():
    current = card()
    if current is None:
        tool({'action': 'create', 'title': 'Private unfinished rehearsal work', 'assignee': 'worker', 'needs_review': False})
        current = wait('real MCP task create', card)
        tool({'action': 'claim', 'id': current['uuid']})
        current = wait('real MCP task claim', lambda: c if (c := card()) and c['status'] == 'claimed' else None)
    else:
        version = current['version']
        tool({'action': 'update', 'id': current['uuid'], 'log': 'Next private interruption leg.'})
        current = wait('real MCP task update', lambda: c if (c := card()) and c['version'] > version else None)
    def checkpointed():
        s = observed()
        return s if s and s['observation']['sessionId'] and not s['observation']['turn'] and any(
            r['kind'] == 'task' and r['id'] == current['uuid'] and r['version'] == current['version'] for r in s['references']) else None
    wait('task-only owned checkpoint', checkpointed)
    return current

def begin(leg):
    global active_leg
    active_leg = leg
    # Each leg has an independent production start-limit budget. Never raise
    # that budget or reset it in the middle of the two-failed-boots sequence.
    sd('reset-failed', UNIT)
    journal = user('journalctl --user -u '+UNIT+' -n 1 --show-cursor --no-pager', ok=False).stdout
    cursors[leg] = journal.split('-- cursor: ', 1)[1].strip() if '-- cursor: ' in journal else None

def capture(leg):
    cursor = cursors.get(leg)
    (ROOT/(leg+'-journal.log')).write_text(user('journalctl --user -u '+UNIT+' --no-pager'+(' --after-cursor='+shlex.quote(cursor) if cursor else ''), ok=False).stdout)
    if (DATA/'daemon.log').exists(): shutil.copyfile(DATA/'daemon.log', ROOT/(leg+'-daemon.log'))

def continuation(leg, count_before, pid=None):
    current = wait(leg+' final READY', ready)
    if pid is not None: check(leg+' expected replacement PID', current['MainPID'] != pid, current)
    ready_at = next(t['at'] for t in reversed(timeline()) if t['event'] == 'final-ready' and t['pid'] == int(current['MainPID']))
    check(leg+' no early continuation', len(inputs()) == count_before)
    entry = wait(leg+' continuation', lambda: rows[-1] if len(rows := inputs()) > count_before else None, timeout=210)
    check(leg+' stability interval is real', entry['at']-ready_at >= 120_000, {'ready': ready_at, 'input': entry})
    check(leg+' advisory instructions reached real stdin', all(s in entry['text'] for s in [
        'background state is unknown', 'jobs, processes, worktrees, receipts', 'only unfinished work', 'Never restart a command or re-send a delegation blindly']))
    check(leg+' one physical continuation', len(inputs()) == count_before+1)
    receipt['legs'][leg] = {'unit': current, 'ready_at': ready_at, 'input': entry}
    capture(leg)
    return current

try:
    check('private boundary', P('/.dockerenv').exists() and os.environ.get('AGEND_WORKING_REHEARSAL') == '1')
    check('hard memory/swap cap', P('/sys/fs/cgroup/memory.max').read_text().strip() == '1610612736'
        and P('/sys/fs/cgroup/memory.swap.max').read_text().strip() == '0')
    check('systemd249 and scratch user', run(['systemd', '--version']).stdout.startswith('systemd 249') and pwd.getpwnam('rh').pw_uid == 1000)
    run(['loginctl', 'enable-linger', 'rh']); run(['systemctl', 'start', 'user@1000.service'])
    wait('private user manager', lambda: P('/run/user/1000/systemd/private').exists())
    check('no preexisting private fleet', sd('is-active', UNIT, ok=False).stdout.strip() not in ['active', 'activating'])
    PKG.parent.mkdir(parents=True, exist_ok=True); (PREFIX/'bin').mkdir(parents=True)
    shutil.move(str(ROOT/'pkg'), str(PKG)); (PREFIX/'bin/agend').symlink_to(PKG/'launcher/agend')
    DATA.mkdir(parents=True, mode=0o700)
    for n in ['general', 'worker', 'sibling']: (HOME/'working-recovery/work'/n).mkdir(parents=True)
    config = {'channel': {'type': 'telegram', 'mode': 'topic', 'bot_token_env': 'AGEND_BOT_TOKEN', 'group_id': -1001234567890,
        'telegram_api_root': 'http://127.0.0.1:18443', 'access': {'mode': 'locked', 'allowed_users': [111222333]}},
        'defaults': {'backend': 'mock', 'model': 'mock-model', 'tool_set': 'standard', 'resume_interrupted_work': True,
            'startup': {'concurrency': 3, 'stagger_delay_ms': 0}, 'hang_detector': {'enabled': False},
            'context_guardian': {'grace_period_ms': 600000, 'max_age_hours': 0}},
        'instances': {n: {'working_directory': str(HOME/'working-recovery/work'/n), 'topic_id': t,
            **({'general_topic': True} if n == 'general' else {})} for n, t in [('general', 42), ('worker', 63), ('sibling', 87)]}, 'health_port': 19280}
    (DATA/'fleet.yaml').write_text(json.dumps(config)); (DATA/'.env').write_text('AGEND_BOT_TOKEN=123456:rehearsal\n')
    for name, text in [('pressure', 'normal'), ('boot-faults', '0')]: (ROOT/name).write_text(text)
    fixture = PKG/'e2e/mock-servers/mock-claude.mjs'
    source = fixture.read_text().replace('writeFileSync, existsSync, readFileSync', 'writeFileSync, existsSync, readFileSync, appendFileSync')
    source = source.replace('const sessionId = `mock-${INSTANCE_NAME}-${Date.now()}`;', 'const sessionId = `owned-mock-${INSTANCE_NAME}-rehearsal`;')
    source = source.replace('writeStatusline();\nconst statusTimer', 'writeFileSync(join(INSTANCE_DIR, "mock-cli.pid"), String(process.pid));\nwriteStatusline();\nconst statusTimer', 1)
    source = source.replace('  if (!trimmed) return;', '''  if (!trimmed) return;
  if (trimmed === "/quit") { mcpChild.kill("SIGTERM"); process.exit(0); }
  if (trimmed.includes("[system:working-recovery]")) {
    appendFileSync("/opt/rehearsal/physical-input.jsonl", JSON.stringify({at:Date.now(),pid:process.pid,instance:INSTANCE_NAME,text:trimmed})+"\\n");
    return;
  }
  if (trimmed.includes("__OOM_MAIN__")) {
    spawn("python3", ["-c", "from pathlib import Path; import time; Path('/proc/self/oom_score_adj').write_text('0'); a=[]; exec(\\\"while True: a.append(bytearray(4*1024*1024)); time.sleep(.01)\\\")"], {stdio:"ignore"});
    return;
  }''', 1)
    fixture.write_text(source)
    (ROOT/'telegram-server.mjs').write_text("import {createTelegramMock} from './telegram-mock.mjs'; await createTelegramMock({port:18443}).start();\n")
    run(['chown', '-R', 'rh:rh', str(ROOT), str(HOME/'working-recovery')])
    user(f'node {PKG}/launcher/postinstall.cjs'); check('packaged CLI runs', user('agend --version').returncode == 0)
    mock = subprocess.Popen(['node', str(ROOT/'telegram-server.mjs')], stdout=open(ROOT/'telegram.log', 'w'), stderr=subprocess.STDOUT)
    wait('loopback Telegram', lambda: http('/control/calls') is not None)
    user('agend install --no-activate')
    drop = HOME/'.config/systemd/user'/(UNIT+'.d'); drop.mkdir(parents=True, exist_ok=True)
    (drop/'zz-working-recovery.conf').write_text('[Service]\nMemoryMax=768M\nMemorySwapMax=0\nEnvironment=AGEND_WORKING_REHEARSAL=1\nEnvironment=NODE_OPTIONS=--import=/opt/rehearsal/bootstrap.mjs\nEnvironment=MOCK_RESPONSE=Mock\\x20sibling\\x20survived\n')
    run(['chown', '-R', 'rh:rh', str(drop)]); sd('daemon-reload'); sd('start', UNIT); first = wait('initial READY', ready)
    check('loaded persistent user-unit policy', first['Type'] == 'notify' and first['NotifyAccess'] == 'all'
        and first['OOMPolicy'] == 'continue' and first['MemoryMax'] == '805306368' and first['MemorySwapMax'] == '0', first)
    sibling_reply('initial sibling current route')
    seed_or_update(); begin('manual'); count = len(inputs()); before = state()
    (ROOT/'pressure').write_text('elevated'); sd('restart', UNIT); held = wait('manual READY under elevated pressure', ready)
    time.sleep(125)  # Real monotonic stability interval; no production clock override.
    check('elevated pressure defers past stability without loss', len(inputs()) == count and state()['MainPID'] == held['MainPID'] and state()['NRestarts'] == held['NRestarts'])
    released_at = int(time.time()*1000); (ROOT/'pressure').write_text('normal')
    continuation('manual', count, before['MainPID'])
    check('thirty normal seconds after pressure release', inputs()[-1]['at']-released_at >= 30_000, {'released_at': released_at, 'input_at': inputs()[-1]['at']})
    sibling_reply('manual sibling current route')

    seed_or_update(); begin('main-oom'); count = len(inputs()); before = state(); sibling_reply('main OOM sibling ready')
    group = P('/sys/fs/cgroup')
    events_before = dict((k, int(v)) for k, v in (l.split() for l in (group/'memory.events').read_text().splitlines()))
    victim = P('/proc')/before['MainPID']
    check('OOM victim is owned private MainPID', str(PKG).encode() in (victim/'cmdline').read_bytes()
        and before['ControlGroup'] in (victim/'cgroup').read_text() and victim.stat().st_uid == 1000)
    (victim/'oom_score_adj').write_text('1000')
    http('/control/send-message', {'text': '__OOM_MAIN__', 'chat_id': -1001234567890, 'thread_id': 42, 'user_id': 111222333})
    wait('actual OOM replacement', lambda: s if (s := ready()) and s['MainPID'] != before['MainPID'] else None)
    events_after = dict((k, int(v)) for k, v in (l.split() for l in (group/'memory.events').read_text().splitlines()))
    check('actual kernel OOM kill and automatic restart', events_after['oom_kill'] > events_before['oom_kill'] and int(state()['NRestarts']) > int(before['NRestarts']), [events_before, events_after, state()])
    continuation('main-oom', count, before['MainPID'])
    check('main OOM unit journal confirms SIGKILL', 'status=9/KILL' in (ROOT/'main-oom-journal.log').read_text())
    sibling_reply('OOM sibling current route')

    seed_or_update(); begin('boot-loop'); count = len(inputs()); before = state(); (ROOT/'boot-faults').write_text('2'); sd('restart', UNIT, ok=False)
    wait('two actual boot exits', lambda: len([t for t in timeline() if t['event'] == 'pre-ready-boot-exit']) == 2)
    check('no recovery during failed boots', len(inputs()) == count)
    continuation('boot-loop', count, before['MainPID']); sibling_reply('boot loop sibling current route')

    seed_or_update(); begin('ambiguous'); count = len(inputs()); (ROOT/'kill-after-input').write_text('1'); sd('restart', UNIT)
    wait('one observed input then process death', lambda: any(t['event'] == 'kill-after-observed-input' for t in timeline()), timeout=210)
    killed = next(t['pid'] for t in reversed(timeline()) if t['event'] == 'kill-after-observed-input')
    restarted = wait('ambiguous replacement READY', lambda: s if (s := ready()) and int(s['MainPID']) != killed else None)
    ready_at = next(t['at'] for t in reversed(timeline()) if t['event'] == 'final-ready' and t['pid'] == int(restarted['MainPID']))
    wait('replacement stability window elapsed', lambda: time.time()*1000-ready_at > 130_000, timeout=150)
    check('ambiguous input is never pasted twice', len(inputs()) == count+1, inputs()[count:])
    rows = query('delivery-outbox.db', "SELECT state FROM deliveries WHERE kind='working_recovery' ORDER BY created_seq DESC LIMIT 1")
    check('ambiguous row remains held after replacement', rows[0]['state'] in ['uncertain', 'submission_started'], rows)
    receipt['legs']['ambiguous'] = {'unit': restarted, 'ready_at': ready_at, 'killed_pid': killed,
        'observed_at': int(time.time()*1000), 'physical_inputs': len(inputs())-count, 'rows': rows}
    capture('ambiguous'); sibling_reply('ambiguous sibling current route')
finally:
    if active_leg:
        try: capture(active_leg)
        except Exception: pass
    try:
        (ROOT/'telegram-calls.json').write_text(json.dumps(calls(), indent=2)); (ROOT/'final-unit.json').write_text(json.dumps(state(), indent=2))
        for file, target in [('delivery-outbox.db', 'outbox-snapshot.db'), ('scheduler.db', 'scheduler-snapshot.db')]:
            with sqlite3.connect(f'file:{DATA/file}?mode=ro', uri=True) as src, sqlite3.connect(ROOT/target) as dst: src.backup(dst)
    except Exception: pass
    try: sd('stop', UNIT, ok=False)
    except Exception: pass
    if mock is not None:
        mock.terminate()
        try: mock.wait(timeout=5)
        except subprocess.TimeoutExpired: mock.kill(); mock.wait()
    (ROOT/'results.json').write_text(json.dumps(receipt, indent=2))
