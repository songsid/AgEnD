"""Bounded real-CLI captures inside run.sh's private namespaces; no account."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import time
from urllib.parse import quote
import uuid

ROOT = Path('/rig')
OUT = ROOT / 'out'
OUT.mkdir(exist_ok=True)
SOCKET = '/tmp/grok-1089-audit.sock'
env = dict(os.environ, XAI_API_KEY='xai-dummy-audit',
           GROK_XAI_API_BASE_URL='http://127.0.0.1:18080/v1',
           XAI_API_BASE_URL='http://127.0.0.1:18080/v1',
           GROK_CLI_BASE_URL='http://127.0.0.1:18080')
mock = subprocess.Popen(['/audit-node', '/harness/mock.cjs'],
                        env=dict(env, MOCK_LOG=str(OUT / 'mock.jsonl'), COMPACT_ERR_FILE=str(ROOT / 'compact-error'),
                                 MCP_TOOL_ARGS=json.dumps({'tool_name': 'agend-audit-grok__reply',
                                                           'tool_input': {'text': 'audit reply'}})),
                        stdout=(OUT / 'mock.stdout').open('w'), stderr=subprocess.STDOUT)


def tm(*args, check=True):
    p = subprocess.run(['tmux', '-S', SOCKET, *args], text=True,
                       capture_output=True, timeout=8)
    if check and p.returncode:
        raise RuntimeError('tmux failed: ' + p.stderr.strip())
    return p.stdout


def pane():
    return tm('capture-pane', '-p', '-t', 'audit', '-S', '-120')


def capture(name):
    text = pane()
    if not text.strip():
        raise RuntimeError('empty pane: ' + name)
    (OUT / (name + '.pane.txt')).write_text(text)
    return text


def wait_until(predicate, description, timeout=20):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        text = pane()
        if text.strip() and predicate(text):
            return text
        time.sleep(.2)
    capture('FAILED-wait')
    raise RuntimeError('timed out waiting for ' + description)


def wait_for(needle, timeout=20):
    return wait_until(lambda p: needle in p, needle, timeout)


def idle():
    return wait_until(lambda p: 'Shift+Tab:mode' in p.rstrip().splitlines()[-1]
                      and 'Ctrl+x:shortcuts' in p.rstrip().splitlines()[-1] and '[stop]' not in p,
                      'idle composer')


def key(*keys):
    tm('send-keys', '-t', 'audit', *keys)


def paste(text, enter=True):
    tm('set-buffer', '-b', 'input', '--', text)
    tm('paste-buffer', '-p', '-d', '-b', 'input', '-t', 'audit')
    time.sleep(.3)
    if enter:
        key('Enter')


def start(label, width=120, approve=True, resume=None, auth=True, command=None):
    tm('kill-session', '-t', 'audit', check=False)
    work = ROOT / 'work' / label
    home = ROOT / 'homes' / label
    work.mkdir(parents=True, exist_ok=True)
    home.mkdir(parents=True, exist_ok=True)
    wrapper = work / 'mcp.sh'
    wrapper.write_text('#!/bin/sh\nexec /audit-node /harness/mcp-stub.cjs\n')
    wrapper.chmod(0o700)
    (work / '.mcp.json').write_text(json.dumps({'mcpServers': {
        'agend-audit-grok': {'command': str(wrapper), 'args': []}}}))
    (work / 'AGENTS.md').write_text('Audit fixture. Reply briefly.\n')
    subprocess.run(['git', 'init', '-q', str(work)], check=True)
    sid = resume or str(uuid.uuid4())
    args = ['/audit-grok', '--no-auto-update', '--no-leader', '--model', 'grok-mock']
    if approve:
        args += ['--always-approve']
    else:
        args += ['--permission-mode', 'default']
    args += ['--resume' if resume else '--session-id', sid]
    if command:
        args = ['/audit-grok', '--no-auto-update', *command]
    session_env = dict(env, HOME=str(home), MCP_LOG=str(OUT / 'mcp.jsonl'))
    if not auth:
        session_env.pop('XAI_API_KEY', None)
    launch = ['new-session', '-d', '-s', 'audit', '-x', str(width), '-y', '44', '-c', str(work)]
    for k, v in session_env.items():
        launch += ['-e', k + '=' + v]
    launch += [shlex.join(args)]
    tm(*launch)
    tm('set-option', '-t', 'audit', 'remain-on-exit', 'on')
    return sid, work, home


def ready(label, width=120, approve=True):
    sid, work, home = start(label, width, approve)
    wait_for('Do you trust')
    capture(label + '-trust')
    key('y')
    idle()
    capture(label + '-ready')
    return sid, work, home


def updates(home, work, sid):
    p = home / '.grok' / 'sessions' / quote(str(work), safe='') / sid / 'updates.jsonl'
    return p.read_text() if p.exists() else ''


def user_records(home, work, sid, name):
    rows = []
    for line in updates(home, work, sid).splitlines():
        r = json.loads(line)
        if r.get('params', {}).get('update', {}).get('sessionUpdate') == 'user_message_chunk':
            rows.append(r)
    (OUT / (name + '.jsonl')).write_text(''.join(json.dumps(r) + '\n' for r in rows))
    return len(rows)


def envelope(letter, long=False):
    marker = '[agend-delivery-id:' + letter * 8 + '-1111-4111-8111-' + letter * 12 + ']'
    lines = [marker, '[from:Audit peer (audit-peer)] please stall a']
    if long:
        lines += ['inert audit line ' + str(i) for i in range(18)]
    return '\n'.join(lines + ['(message_id: audit-message)'])


def full():
    sid, work, home = ready('core-120')
    paste(envelope('a'), False)
    capture('10-short-draft')
    assert user_records(home, work, sid, '10-before-enter') == 0
    key('Enter')
    wait_for('[stop]')
    capture('11-short-taken-busy')
    end = time.monotonic() + 4
    while time.monotonic() < end and not updates(home, work, sid):
        time.sleep(.1)
    assert user_records(home, work, sid, '11-after-enter') > 0
    wait_for('mock reply')
    idle()
    capture('12-short-done')
    paste(envelope('b', True), False)
    time.sleep(.5)
    capture('20-long-draft')
    key('Enter')
    wait_for('[stop]')
    capture('21-long-taken-busy')
    paste(envelope('c'))
    time.sleep(.5)
    capture('22-busy-queued')
    idle()
    time.sleep(.5)
    idle()
    capture('23-queue-drained')
    user_records(home, work, sid, '23-after-queue')
    paste('stall forever b')
    wait_for('[stop]')
    capture('30-before-cancel')
    key('C-c')
    idle()
    capture('31-after-cancel')
    # A fresh pane avoids the CLI's draft-restoration behavior contaminating errors.
    sid, work, home = ready('errors-120')
    cases = [('a', '401', 'Authentication'), ('c', '403', '403'),
             ('g', '403-usage', 'usage limit'), ('d', '426', '426'),
             ('e', '429', 'rate_limit_error'), ('h', '429-text', 'rate_limit_error'),
             ('f', '500', '500')]
    for letter, name, needle in cases:
        ready('error-' + name + '-120')
        paste('error turn ' + letter)
        wait_for(needle)
        time.sleep(.4)
        capture('40-error-' + name)
        if letter == 'f':
            key('C-c')
        time.sleep(.3)
    sid, work, home = ready('limits-120')
    paste('error turn b')
    wait_for('Try Again')
    capture('50-weekly-picker')
    key('Escape')
    time.sleep(.3)
    capture('51-weekly-scrollback')
    key('X')
    time.sleep(.3)
    capture('52-weekly-scrollback-x')
    key('Space')
    time.sleep(.3)
    capture('53-weekly-question')
    tm('send-keys', '-l', '-t', 'audit', '\t')
    wait_until(lambda p: 'Shift+x:dismiss' in p.rstrip().splitlines()[-1], 'question focus')
    capture('53b-weekly-after-tab')
    key('X')
    idle()
    capture('54-weekly-dismissed')
    sid, work, home = ready('commands-120')
    paste('use tool please')
    wait_for('tool done')
    idle()
    capture('60-tool')
    paste('mcp tool please')
    time.sleep(2)
    idle()
    capture('61-mcp')
    paste('/model grok-4 high')
    wait_for('Switched to grok-4')
    capture('62-model')
    paste('/effort low')
    wait_for('low effort')
    capture('63-effort')
    paste('/model definitely-unknown')
    wait_for('Unknown model')
    capture('64-unknown-model')
    paste('/compact ')
    time.sleep(.5)
    capture('65-compact')
    idle()
    key('C-q')
    time.sleep(.3)
    capture('66-quit-once')
    key('C-q')
    key('C-q')
    time.sleep(.5)
    capture('67-quit-twice')
    start('commands-120', resume=sid)
    idle()
    capture('68-resume')
    paste('/new')
    time.sleep(1)
    idle()
    capture('69-new')
    # A never-submitted envelope must produce no structured input record.
    sid, work, home = ready('never-enter-80', 80)
    paste(envelope('d', True), False)
    time.sleep(2)
    capture('70-never-enter')
    assert user_records(home, work, sid, '70-never-enter') == 0
    sid, work, home = ready('core-80', 80)
    paste('please stall a')
    wait_for('[stop]')
    capture('80-busy')
    idle()
    capture('81-done')
    paste('error turn e')
    wait_for('rate_limit_error')
    capture('82-rate-limit')
    paste('error turn b')
    wait_for('Try Again')
    capture('83-weekly')
    key('X')
    idle()
    capture('84-dismissed')
    tail()


def tail():
    ready('approval-120', approve=False)
    paste('approval use tool please')
    wait_for('Yes, proceed')
    capture('90-approval')
    key('Escape')
    time.sleep(.5)
    capture('91-approval-escape')
    dashboard()


def dashboard():
    start('dashboard-120', command=['dashboard'])
    wait_for('Do you trust')
    key('y')
    time.sleep(2)
    capture('95-dashboard')
    for i, k in enumerate(['Enter', 'Enter', 'Escape', 'C-l', 'Escape']):
        key(k)
        time.sleep(.6)
        capture('96-dashboard-' + str(i))


def login():
    start('login-120', auth=False)
    first = wait_until(lambda p: any(t in p for t in ['Do you trust', 'Sign in with Grok', 'Waiting for approval']), 'trust or sign-in')
    if 'Do you trust' in first:
        key('y')
    time.sleep(3)
    capture('110-no-key')
    login_commands()


def login_commands():
    observations = []
    for label, command in [('login-command', ['login']), ('device-command', ['login', '--device-auth'])]:
        start(label, auth=False, command=command)
        end = time.monotonic() + 10
        while time.monotonic() < end and not pane().strip():
            time.sleep(.2)
        if pane().strip():
            capture('111-' + label)
            observations.append({'command': command, 'screen': 'captured'})
        else:
            observations.append({'command': command, 'screen': 'unreached: empty after ten seconds offline'})
    (OUT / 'login-observations.json').write_text(json.dumps(observations, indent=2))
    for auth in [False, True]:
        model_env = dict(env, HOME='/rig/homes/models')
        Path(model_env['HOME']).mkdir(parents=True, exist_ok=True)
        if not auth:
            model_env.pop('XAI_API_KEY', None)
        try:
            p = subprocess.run(['/audit-grok', '--no-auto-update', 'models'], env=model_env,
                               capture_output=True, text=True, timeout=8)
            text = p.stdout + p.stderr
        except subprocess.TimeoutExpired:
            text = 'The isolated no-network command exceeded the eight-second bound.\n'
        (OUT / ('112-models-' + str(auth) + '.txt')).write_text(text)


def weekly():
    ready('weekly-120')
    paste('error turn b')
    wait_for('Try Again')
    time.sleep(.3)
    capture('100-picker')
    def post_count():
        return sum(json.loads(r).get('method') == 'POST'
                   for r in (OUT / 'mock.jsonl').read_text().splitlines())
    before = post_count()
    key('Escape')
    time.sleep(.3)
    capture('101-scrollback')
    key('X')
    time.sleep(.3)
    capture('102-scrollback-x')
    key('Space')
    time.sleep(.3)
    after_space = capture('103-after-space')
    if 'Shift+x:dismiss' in after_space.rstrip().splitlines()[-1]:
        key('Escape')
        time.sleep(.3)
    tm('send-keys', '-l', '-t', 'audit', '\t')
    wait_until(lambda p: 'Shift+x:dismiss' in p.rstrip().splitlines()[-1], 'question focus')
    capture('104-after-tab')
    key('X')
    idle()
    capture('105-dismissed')
    after = post_count()
    (OUT / 'weekly-requests.json').write_text(json.dumps({'beforeKeys': before, 'afterKeys': after}))
    assert before > 0 and after == before


def extra_errors():
    ready('429-text-120')
    paste('error turn h')
    wait_for('rate_limit_error')
    idle()
    capture('120-rate-limit-text')


def weekly_reset():
    ready('reset-120')
    paste('error turn b')
    wait_for('Try Again')
    key('Down')
    key('Down')
    time.sleep(.3)
    capture('130-two-downs')
    ansi = tm('capture-pane', '-e', '-p', '-t', 'audit')
    (OUT / '130-two-downs.ansi.txt').write_text(ansi)
    # Do not submit until the selection's rendering has been inspected by the auditor.
    key('Down')
    time.sleep(.3)
    capture('131-third-down')
    final_ansi = tm('capture-pane', '-e', '-p', '-t', 'audit')
    (OUT / '131-third-down.ansi.txt').write_text(final_ansi)
    # Only submit the independently observed selected Try Again row. Never infer a paid-option index.
    assert any('\x1b[48;2;54;54;54m3 ' in row and 'Try Again' in row for row in final_ansi.splitlines())
    (ROOT / 'allow-weekly-retry').write_text('local mock only\n')
    key('Enter')
    wait_for('mock reply')
    idle()
    capture('132-retry-success')
    (ROOT / 'allow-weekly-retry').unlink()
    ready('still-limited-120')
    paste('error turn b')
    wait_for('Try Again')
    key('Down')
    key('Down')
    time.sleep(.3)
    selected = tm('capture-pane', '-e', '-p', '-t', 'audit')
    assert any('\x1b[48;2;54;54;54m3 ' in row and 'Try Again' in row for row in selected.splitlines())
    before = sum(json.loads(row).get('method') == 'POST' for row in (OUT / 'mock.jsonl').read_text().splitlines())
    key('Enter')
    wait_until(lambda p: 'Try Again' in p and 'Shift+x:dismiss' in p.rstrip().splitlines()[-1], 'still-limited picker')
    time.sleep(.5)
    capture('133-still-limited')
    key('X')
    idle()
    capture('134-still-dismissed')
    after = sum(json.loads(row).get('method') == 'POST' for row in (OUT / 'mock.jsonl').read_text().splitlines())
    assert after == before + 1
    (OUT / 'retry-requests.json').write_text(json.dumps({'beforeRetry': before, 'afterRetryAndDismiss': after}))


def usage_errors():
    for width in [120, 80]:
        for letter, title in [('i', '401-usage'), ('j', '401-credits'), ('k', '401-ordinary')]:
            ready(title + '-' + str(width), width)
            paste('error turn ' + letter)
            wait_until(lambda p: ('Authentication' in p or 'usage limit' in p or 'credits' in p or 'Try Again' in p), 'usage/auth error')
            time.sleep(.6)
            capture(title + '-' + str(width))
            if 'Try Again' in pane():
                key('X')
                idle()
                capture(title + '-' + str(width) + '-dismissed')


def compact_errors():
    for width in [120, 80]:
        for letter, title in [('i', '401-usage'), ('j', '401-credits'), ('k', '401-auth')]:
            error_file = ROOT / 'compact-error'
            error_file.unlink(missing_ok=True)
            ready('compact-' + title + '-' + str(width), width)
            paste('brief ordinary turn')
            wait_for('mock reply')
            idle()
            error_file.write_text(letter)
            paste('/compact ')
            wait_for('Compaction')
            time.sleep(1)
            capture('compact-' + title + '-' + str(width))
    (ROOT / 'compact-error').unlink(missing_ok=True)


def remaining():
    for letter, title, needle in [('h','429-text','too many requests'),('f','500','500')]:
        ready('remaining-' + title)
        paste('error turn ' + letter)
        wait_for(needle)
        capture('40-error-' + title)
        if letter == 'f':
            key('C-c')
            idle()
    sid, work, home = ready('limits-120')
    paste('error turn b')
    wait_for('Try Again')
    capture('50-weekly-picker')
    key('Escape')
    time.sleep(.3)
    capture('51-weekly-scrollback')
    key('X')
    time.sleep(.3)
    capture('52-weekly-scrollback-x')
    key('Space')
    time.sleep(.3)
    capture('53-weekly-question')
    tm('send-keys', '-l', '-t', 'audit', '\t')
    wait_until(lambda p: 'Shift+x:dismiss' in p.rstrip().splitlines()[-1], 'question focus')
    capture('53b-weekly-after-tab')
    key('X')
    idle()
    capture('54-weekly-dismissed')
    sid, work, home = ready('commands-120')
    paste('use tool please')
    wait_for('tool done')
    idle()
    capture('60-tool')
    paste('mcp tool please')
    time.sleep(2)
    idle()
    capture('61-mcp')
    paste('/model grok-4 high')
    wait_for('Switched to grok-4')
    capture('62-model')
    paste('/effort low')
    wait_for('low effort')
    capture('63-effort')
    paste('/model definitely-unknown')
    wait_for('Unknown model')
    capture('64-unknown-model')
    paste('/compact ')
    time.sleep(.5)
    capture('65-compact')
    idle()
    key('C-q')
    time.sleep(.3)
    capture('66-quit-once')
    key('C-q')
    key('C-q')
    time.sleep(.5)
    capture('67-quit-twice')
    start('commands-120', resume=sid)
    idle()
    capture('68-resume')
    paste('/new')
    time.sleep(1)
    idle()
    capture('69-new')
    # A never-submitted envelope must produce no structured input record.
    sid, work, home = ready('never-enter-80', 80)
    paste(envelope('d', True), False)
    time.sleep(2)
    capture('70-never-enter')
    assert user_records(home, work, sid, '70-never-enter') == 0
    sid, work, home = ready('core-80', 80)
    paste('please stall a')
    wait_for('[stop]')
    capture('80-busy')
    idle()
    capture('81-done')
    paste('error turn e')
    wait_for('rate_limit_error')
    capture('82-rate-limit')
    paste('error turn b')
    wait_for('Try Again')
    capture('83-weekly')
    key('X')
    idle()
    capture('84-dismissed')
    tail()


def lifecycle():
    sid, work, home = ready('resume-120')
    paste('brief ordinary turn')
    wait_for('mock reply')
    idle()
    key('C-q')
    key('C-q')
    key('C-q')
    time.sleep(.5)
    capture('67-quit-twice')
    start('resume-120', resume=sid)
    idle()
    capture('68-resume')
    paste('/new')
    time.sleep(1)
    idle()
    capture('69-new')
    # A never-submitted envelope must produce no structured input record.
    sid, work, home = ready('never-enter-80', 80)
    paste(envelope('d', True), False)
    time.sleep(2)
    capture('70-never-enter')
    assert user_records(home, work, sid, '70-never-enter') == 0
    sid, work, home = ready('core-80', 80)
    paste('please stall a')
    wait_for('[stop]')
    capture('80-busy')
    idle()
    capture('81-done')
    paste('error turn e')
    wait_for('rate_limit_error')
    capture('82-rate-limit')
    paste('error turn b')
    wait_for('Try Again')
    capture('83-weekly')
    key('X')
    idle()
    capture('84-dismissed')
    tail()


try:
    version = subprocess.run(['/audit-grok', '--no-auto-update', '--version'],
                             capture_output=True, text=True, timeout=10)
    (OUT / 'version.txt').write_text(version.stdout + version.stderr)
    if version.returncode:
        raise RuntimeError('version probe failed')
    time.sleep(.3)
    if os.environ.get('AUDIT_PHASE') == 'lifecycle':
        lifecycle()
    elif os.environ.get('AUDIT_PHASE') == 'remaining':
        remaining()
    elif os.environ.get('AUDIT_PHASE') == 'compact-errors':
        compact_errors()
    elif os.environ.get('AUDIT_PHASE') == 'usage-errors':
        usage_errors()
    elif os.environ.get('AUDIT_PHASE') == 'extra-errors':
        extra_errors()
    elif os.environ.get('AUDIT_PHASE') == 'weekly-reset':
        weekly_reset()
    elif os.environ.get('AUDIT_PHASE') == 'login-commands':
        login_commands()
    elif os.environ.get('AUDIT_PHASE') == 'dashboard':
        dashboard()
    elif os.environ.get('AUDIT_PHASE') == 'login':
        login()
    elif os.environ.get('AUDIT_PHASE') == 'weekly':
        weekly()
    elif os.environ.get('AUDIT_PHASE') == 'tail':
        tail()
    elif os.environ.get('AUDIT_PHASE') == 'full':
        full()
    else:
        sid, work, home = ready('probe')
        paste('please stall a')
        wait_for('[stop]')
        capture('03-busy')
        wait_for('mock reply')
        idle()
        capture('04-done')
        (OUT / 'session.json').write_text(json.dumps({'sessionId': sid, 'work': str(work), 'home': str(home)}))
    print(json.dumps({'phase': os.environ.get('AUDIT_PHASE'), 'version': version.stdout.strip(),
                      'captures': len(list(OUT.glob('*.pane.txt')))}), flush=True)
finally:
    tm('kill-server', check=False)
    mock.terminate()
    try:
        mock.wait(timeout=5)
    except subprocess.TimeoutExpired:
        mock.kill()
        mock.wait()
