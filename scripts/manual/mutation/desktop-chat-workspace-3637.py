"""Owned offline reversals. Restore each exact source image, including on interruption; no product/guard changes remain."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[3]
out = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root / '.artifacts/split-chat-workspace/final-mutations'
out.mkdir(parents=True, exist_ok=True)
cases = [
    ('distinct', 'src/ui/shared/chat-workspace-model.js', [('second === route.instance', 'false')], 'web-chat-workspace-3637'),
    ('width', 'src/ui/shared/chat-workspace-model.js', [('width >= 760', 'true')], 'web-chat-workspace-3637'),
    ('scope', 'src/ui/shared/chat-workspace-memory.js', [('/^[a-f0-9]{64}$/.test(scope)', 'true')], 'web-chat-workspace-3637'),
    ('own-route', 'src/ui/chat-workspace-navigation.js', [('next?.workspace?.[id]?.route || route', 'route')], 'web-chat-workspace-navigation-3637'),
    ('loading-fence', 'src/ui/chat-workspace.js', [('!alive || nav.navStore.get() !== attempt', '!alive')], 'web-chat-workspace-entry-3637'),
    ('retired-entry', 'src/ui/chat-workspace.js', [('async function open(name, layout = "right") {\n    if (!alive) return;', 'async function open(name, layout = "right") {')], 'web-chat-workspace-entry-3637'),
    ('quote-early', 'src/ui/panel-chat.js', [('!field || !String(text || "").trim() || !current()', '!field || !String(text || "").trim()')], 'web-chat-pane-ownership-3637'),
    ('quote-currency-paired', 'src/ui/panel-chat.js', [('!field || !String(text || "").trim() || !current()', '!field || !String(text || "").trim()'), ('if (!next || !current()) return false;', 'if (!next) return false;')], 'web-chat-pane-ownership-3637'),
    ('quote-undo', 'src/ui/panel-chat.js', [('if (!field.dispatchEvent(new Before("beforeinput", { bubbles: true, cancelable: true, inputType: "insertFromPaste" }))) return false;', '/* beforeinput removed */')], 'web-chat-pane-ownership-3637'),
    ('form-prefix', 'src/ui/settings-dialogs.js', [('key == null ? key : `${idPrefix}${key}`', 'key == null ? key : `${key}`')], 'web-chat-pane-fields-3637'),
    ('async-emoji-prefix', 'src/ui/settings-dialogs.js', [('channel=${channel} idPrefix=${idPrefix}', 'channel=${channel}')], 'web-chat-pane-fields-3637'),
    ('settings-remount', 'src/ui/agent-details-settings.js', [('const remount = next && (!!pane !== !!next.workspace);', 'const remount = false;')], 'web-chat-workspace-settings-3637'),
    ('suspended-forms', 'src/ui/settings-dialogs.js', [('paneState.usePaneState(ctx.formMemory, key, initial)', 'paneState.usePaneState(null, key, initial)')], 'web-chat-workspace-suspend-3637'),
    ('suspended-guard', 'src/ui/agent-details-settings.js', [('const hold = off => memory ? memory.hold(off) : lease.hold(off);', 'const hold = off => lease.hold(off);')], 'web-chat-workspace-suspend-3637'),
    ('suspended-retirement', 'src/ui/chat-workspace-navigation.js', [('dispose(record); retained.delete(key);', 'retained.delete(key);')], 'web-chat-workspace-navigation-3637'),
    ('operation-completion-owner', 'src/ui/agent-details-settings.js', [('if (id !== ownership.id || ownership.settledPhase === phase', 'if (ownership.settledPhase === phase')], 'web-chat-workspace-operation-3637'),
    ('operation-leftover-owner', 'src/ui/agent-details-settings.js', [('!op || op.id !== ownership.id || !op.leftover', '!op || !op.leftover')], 'web-chat-workspace-operation-3637'),
    ('operation-late-owner', 'src/ui/agent-details-settings.js', [('!lease.current() || ownership.id !== id', '!lease.current()')], 'web-chat-workspace-operation-3637'),
    ('emoji-draft', 'src/ui/settings-dialogs.js', [('draft=${ctx.formMemory ? emojis : undefined}', 'draft=${undefined}')], 'web-chat-pane-fields-3637'),
    ('split-button-owner', 'src/ui/chat-workspace.js', [('if (owner) controller.focus(owner);', '/* no owner focus */')], 'web-chat-workspace-host-3637'),
    ('logout-cleanup', 'src/ui/shared/app-session.js', [('appStore.get().chatWorkspaceSessionEnd?.();', 'void 0;')], 'web-chat-workspace-session-3637'),
    ('gateway-mark', 'src/web-api.ts', [('const workspaceMark = mode === "full" && !gatewayRequestContext(req) && !viewer?.guest', 'const workspaceMark = mode === "full" && !viewer?.guest')], 'web-chat-workspace-shell-3637'),
]
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
        redundant = name == 'quote-early' and run.returncode == 0
        receipt['cases'].append({'id': name, 'file': file, 'test': test, 'exit': run.returncode, 'assertionCaught': caught, 'redundant': redundant})
        print(name, 'assertion-caught' if caught else 'redundant' if redundant else 'UNEXPECTED', flush=True)
        assert caught or redundant, name
    finally:
        path.write_bytes(original)
        assert path.read_bytes() == original
        (out / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
