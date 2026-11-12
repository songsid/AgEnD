"""Serial offline semantic reversals; run only outside the host quiet window."""
import hashlib
import json
import os
import pathlib
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parents[3]
out = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root / '.artifacts/chat-menu-mutations'
out.mkdir(parents=True, exist_ok=True)
git = lambda *args: subprocess.check_output(['git', *args], cwd=root, text=True).strip()
receipt = {'head': git('rev-parse', 'HEAD'), 'tree': git('rev-parse', 'HEAD^{tree}'), 'inputs': {}, 'cases': []}
menu = 'tests/web-chat-menus-2959.test.ts'
host = 'src/ui/chat-workspace.js'
cases = [
    ('legacy-model-rows', host,
     '![' + '"splitChat", "split", "pane-backend", "pane-model", "pane-effort"].includes(item.key)', 'true', menu),
    ('focused-settings', host, 'pane.focused && inst && supportsInstanceFeature(inst, "details")',
     'inst && supportsInstanceFeature(inst, "details")', menu),
    ('read-only-favourites', 'src/ui/shared/instance-nav.js', 'canStar ? { key: "favorite"', 'true ? { key: "favorite"', menu),
    ('moved-row-focus', 'src/ui/shared/instance-nav.js', 'if (!focusRow.current) return;', 'return;', menu),
    ('selected-name-contrast', 'src/ui/shared/identity-color.js', 'readableShade(light, "light", page, rowBackgrounds)',
     'readableShade(light, "light", page)', menu),
    ('dark-name-unchanged', 'src/ui/shared/identity-color.js', 'readableShade(dark, "dark", pageNow("dark"))',
     'readableShade(dark, "light", pageNow("light"))', menu),
    ('retained-css', 'src/ui/shared/ui-menu.js',
     'getComputedStyle(document.documentElement).getPropertyValue("--agent-menu-version").trim() === "1"', 'true', menu),
    ('retained-css-trigger', 'src/ui/shared/instance-nav.js', 'trigger=${styledMenus ?', 'trigger=${true ?', menu),
    ('placement-scroll-owner', 'src/ui/shared/ui-menu.js', 'if (anchored) window.addEventListener("scroll",place,true);',
     'void 0;', menu),
    ('quote-display-name', host, 'tw("quote", targetName)', 'tw("quote", name)', 'tests/web-chat-workspace-entry-3637.test.ts'),
    ('quote-row-icon', 'src/ui/chat-quote.js', 'b.append(iconEl(doc));\n      const span = doc.createElement("span"); span.textContent = target.label;',
     'const span = doc.createElement("span"); span.textContent = target.label;', 'tests/web-chat-quote-2789.test.ts'),
]
if len(sys.argv) > 2:
    selected = set(sys.argv[2].split(','))
    cases = [case for case in cases if case[0] in selected]
    assert len(cases) == len(selected) > 0
for label, path, before, after, test in cases:
    if os.getloadavg()[0] > 10:
        raise SystemExit('host load above10: pause before the next local test run')
    p = root / path
    original = p.read_bytes()
    assert original == subprocess.check_output(['git', 'show', f'HEAD:{path}'], cwd=root), (label, 'commit the tested source first')
    text = original.decode()
    assert text.count(before) == 1, (label, 'replacement must be exact')
    receipt['inputs'].setdefault(hashlib.sha256(original).hexdigest(), []).append(path)
    try:
        p.write_text(text.replace(before, after, 1))
        subprocess.run(['node', '--check', str(p)], cwd=root, check=True, capture_output=True)
        if os.getloadavg()[0] > 10:
            raise SystemExit('host load above10: source restored; test not started')
        result = subprocess.run(['npx', 'vitest', 'run', test, '--maxWorkers=1'], cwd=root, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (out / f'{label}.log').write_text(result.stdout)
        semantic = result.returncode != 0 and 'AssertionError' in result.stdout and 'Transform failed' not in result.stdout
        receipt['cases'].append({'label': label, 'source': path, 'test': test, 'exit': result.returncode, 'assertionCaught': semantic})
        print(label, result.returncode, 'assertion' if semantic else 'OTHER', flush=True)
    finally:
        p.write_bytes(original)
        assert p.read_bytes() == original
        (out / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
assert len(receipt['cases']) == len(cases) > 0
if not all(case['assertionCaught'] for case in receipt['cases']):
    raise SystemExit(1)
