"""Owned offline reversals. Restore each exact source image, including on interruption; no product/guard changes remain."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[3]
out = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root / '.artifacts/split-chat-docking/mutations'
out.mkdir(parents=True, exist_ok=True)
cases = [
    ('split-minimum', 'src/ui/shared/pane-geometry.js', [('320 : 360', '320 : 0')], 'web-chat-workspace-geometry-3637'),
    ('float-boundary', 'src/ui/shared/pane-geometry.js', [('0, width - w)', '-100000, 100000)')], 'web-chat-workspace-geometry-3637'),
    ('outside-drop', 'src/ui/shared/pane-geometry.js', [('dx < 0 || dy < 0 ||', '')], 'web-chat-workspace-geometry-3637'),
    ('unique-dock', 'src/ui/shared/chat-workspace-model.js', [('const id = source || target;', 'const id = target;')], 'web-chat-workspace-geometry-3637'),
    ('preview-stop', 'src/ui/chat-workspace-navigation.js', [(')) beforeLayout();', ')) void 0;')], 'web-chat-workspace-docking-navigation-3637'),
    ('drop-leave-guard', 'src/ui/chat-workspace-navigation.js', [('if (next !== w) go(next);', 'if (next !== w) go(next, { force: true });')], 'web-chat-workspace-docking-navigation-3637'),
    ('revoked-incarnation', 'src/ui/chat-workspace-gestures.js', [('controller.stamp() === a.stamp &&', '')], 'web-chat-workspace-gestures-3637'),
    ('bounds-fence', 'src/ui/chat-workspace-gestures.js', [('sameBounds(a.bounds, a.root.getBoundingClientRect())', 'true')], 'web-chat-workspace-gestures-3637'),
    ('pointer-owner', 'src/ui/chat-workspace-gestures.js', [('ev.pointerId === undefined || ev.pointerId === pointerId', 'true')], 'web-chat-workspace-gestures-3637'),
    ('escape-cancel', 'src/ui/chat-workspace-gestures.js', [('e.stopImmediatePropagation(); cancel(); return;', 'e.stopImmediatePropagation(); return;')], 'web-chat-workspace-gestures-3637'),
    ('native-target', 'src/ui/chat-workspace-gestures.js', [('a.target = null;\n    const hit', 'hideOverlay(); a.target = null;\n    const hit')], 'web-chat-workspace-gestures-3637'),
    ('native-domrect', 'src/ui/chat-workspace-gestures.js', [('bounds: { left, top, width, height }', 'bounds: root.getBoundingClientRect()')], 'web-chat-workspace-gestures-3637'),
    ('keyboard-browser-keys', 'src/ui/chat-workspace-gestures.js', [('!w || !rect || modified(e) || !usable()', '!w || !rect || !usable()')], 'web-chat-workspace-gestures-3637'),
    ('pane-dom-identity', 'src/ui/chat-workspace.js', [('html`<${Pane} key=${id}', 'html`<${Pane}')], 'web-chat-workspace-host-3637'),
    ('sidebar-dock', 'src/ui/shared/instance-nav.js', [('dock && workspace.dragStart(item.name, e)', 'false')], 'web-chat-workspace-sidebar-3637'),
    ('retained-float-model', 'src/ui/shared/chat-workspace-model.js', [('q.get("layout") === "float" && !allowFloat', 'false')], 'web-chat-workspace-skew-geometry-3637'),
    ('retained-float-layout', 'src/ui/chat-workspace-navigation.js', [('(layout === "float" && !geometry) || ', '')], 'web-chat-workspace-skew-geometry-3637'),
]
if len(sys.argv) > 2:
    selected = set(sys.argv[2].split(','))
    cases = [case for case in cases if case[0] in selected]
    assert len(cases) == len(selected) > 0, 'unknown or empty mutation selection'
git = lambda *args: subprocess.check_output(['git', *args], cwd=root, text=True).strip()
receipt = {'head': git('rev-parse', 'HEAD'), 'tree': git('rev-parse', 'HEAD^{tree}'), 'cases': [], 'inputs': {}}
for name, file, replacements, test in cases:
    path = root / file
    original = path.read_bytes()
    assert original == subprocess.check_output(['git', 'show', f'HEAD:{file}'], cwd=root), f'changed source: {file}'
    receipt['inputs'].setdefault(hashlib.sha256(original).hexdigest(), []).append(file)
    modified = original.decode()
    for old, new in replacements:
        assert old in modified, (name, old)
        modified = modified.replace(old, new, 1)
    try:
        path.write_text(modified)
        if file.endswith('.js'):
            subprocess.run(['node', '--check', file], cwd=root, check=True, capture_output=True)
        run = subprocess.run(['npx', 'vitest', 'run', f'tests/{test}.test.ts', '--maxWorkers=1', '--reporter=dot'], cwd=root, capture_output=True, text=True, timeout=90)
        log = run.stdout + run.stderr
        (out / f'{name}.log').write_text(log)
        caught = run.returncode != 0 and 'AssertionError' in log
        redundant = False
        receipt['cases'].append({'id': name, 'file': file, 'test': test, 'exit': run.returncode, 'assertionCaught': caught, 'redundant': redundant})
        print(name, 'assertion-caught' if caught else 'redundant' if redundant else 'UNEXPECTED', flush=True)
        assert caught or redundant, name
    finally:
        path.write_bytes(original)
        assert path.read_bytes() == original
        (out / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
