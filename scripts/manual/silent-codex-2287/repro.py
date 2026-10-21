"""Private-container-only Codex pane/rollout timing capture; never starts AgEnD."""
import json, os, pathlib, socket, subprocess, time
if not pathlib.Path('/.dockerenv').is_file() or os.environ.get('AGEND_2287_REPRO') != 'private-container':
    raise SystemExit('Use the documented disposable network-disabled container')
if {name for _, name in socket.if_nameindex()} != {'lo'}:
    raise SystemExit('Requires --network none')
root = pathlib.Path('/home/rh/cx2287')
sock = str(root / 'private.sock')
def tmux(*args):
    return subprocess.run(['tmux', '-S', sock, *args], check=True, text=True, capture_output=True).stdout
for name in ['home', 'code', 'work', 'evidence']:
    (root / name).mkdir(parents=True, exist_ok=True)
(root / 'code/config.toml').write_text('''model = "mock-model"
model_provider = "mock"
check_for_update_on_startup = false
[model_providers.mock]
name = "mock"
base_url = "http://127.0.0.1:18882/v1"
wire_api = "responses"
requires_openai_auth = false
[tui]
status_line = ["context-remaining"]
''')
mock = subprocess.Popen(['node', str(root / 'mock.mjs')], env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'PORT': '18882', 'MOCK_LOG': str(root / 'http.log')})
try:
    for _ in range(40):
        if (root / 'http.log').exists(): break
        time.sleep(.1)
    tmux('new-session', '-d', '-s', 'repro', '-x', '100', '-y', '24', '-c', str(root / 'work'),
         f'env -i HOME={root}/home CODEX_HOME={root}/code PATH=/usr/local/bin:/usr/bin:/bin TERM=xterm-256color LANG=C.UTF-8 /opt/codex-audit/bin/codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen')
    for _ in range(120):
        pane = tmux('capture-pane', '-p', '-t', 'repro')
        if 'Ask Codex to do anything' in pane and 'Context 100% left' in pane: break
        time.sleep(.1)
    else: raise RuntimeError('No ready composer')
    text = '[quiet-heartbeat-2287] Check the inert task board; if nothing changed, stay silent.'
    (root / 'evidence/before.pane.txt').write_text(pane)
    tmux('set-buffer', '--', text); tmux('paste-buffer', '-p', '-t', 'repro'); time.sleep(.3)
    (root / 'evidence/pasted.pane.txt').write_text(tmux('capture-pane', '-p', '-t', 'repro'))
    tmux('send-keys', '-t', 'repro', 'Enter')
    started = time.monotonic(); events = []
    for due in [.1, .5, 1, 3, 5, 10, 65]:
        time.sleep(max(0, due - (time.monotonic() - started)))
        pane = tmux('capture-pane', '-p', '-t', 'repro')
        history = tmux('capture-pane', '-p', '-S', '-300', '-t', 'repro')
        (root / f'evidence/at-{due}.pane.txt').write_text(pane)
        (root / f'evidence/at-{due}.history.txt').write_text(history)
        files = sorted((root / 'code/sessions').rglob('rollout-*.jsonl'))
        users = []
        for file in files:
            for line in file.read_text().splitlines():
                try: entry = json.loads(line)
                except json.JSONDecodeError: continue
                payload = entry.get('payload', {})
                if entry.get('type') == 'response_item' and payload.get('role') == 'user':
                    if any(item.get('text') == text for item in payload.get('content', [])):
                        users.append({'timestamp': entry.get('timestamp'), 'file': file.name})
        events.append({'seconds': round(time.monotonic() - started, 3), 'requestedSeconds': due, 'rawTextInViewport': text in pane, 'rawTextInHistory': text in history, 'rolloutUserEntries': users})
        print(events[-1], flush=True)
    (root / 'evidence/timeline.json').write_text(json.dumps(events, indent=2) + '\n')
    (root / 'evidence/version.txt').write_text(subprocess.check_output(['/opt/codex-audit/bin/codex', '--version'], text=True))
finally:
    try: tmux('kill-server')
    except subprocess.CalledProcessError: pass
    mock.terminate(); mock.wait(timeout=5)
