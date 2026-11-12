"""Three valid phone-heading reversals; serial, with exact source restoration."""
from pathlib import Path
import hashlib, json, os, subprocess, sys
root = Path(__file__).resolve().parents[4]
out = Path(sys.argv[1]).resolve(); out.mkdir(parents=True, exist_ok=True)
p = root / 'src/ui/panel-details.js'; original = p.read_bytes()
link = '<a class="s-back" href=${detailsPath(name)}><${Icon} name="back" size=${16} /><span>${t("app.details")}</span></a>'
heading = '<div class="s-row agent-settings-heading">'
cases = [
    ('separate-back-row', heading + link, link + heading),
    ('duplicate-section-label', '<span>${t("app.details")}</span></a>', '<span>${t("app.details")}</span><span class="s-back-here">Duplicate</span></a>'),
    ('missing-index-title', '<h2>${pt("title")}</h2>${backLink()}', '${backLink()}'),
]
r = dict(head=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(), runner=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), cases=[])
for label, before, after in cases:
    assert os.getloadavg()[0] <= 10
    text = original.decode(); assert text.count(before) == 1
    try:
        p.write_text(text.replace(before, after, 1))
        subprocess.run(['node', '--check', str(p)], cwd=root, check=True, capture_output=True)
        done = subprocess.run(['npx', 'vitest', 'run', 'tests/web-agent-back-chat-3714.test.ts', '--maxWorkers=1'], cwd=root, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (out / (label + '.log')).write_text(done.stdout)
        caught = done.returncode != 0 and 'AssertionError' in done.stdout and not any(x in done.stdout for x in ['Transform failed', 'ReferenceError', 'TypeError'])
        r['cases'].append(dict(label=label, exit=done.returncode, assertionCaught=caught)); print(label, caught, flush=True)
    finally:
        p.write_bytes(original); assert p.read_bytes() == original
        (out / 'receipt.json').write_text(json.dumps(r, indent=2) + '\n')
assert all(x['assertionCaught'] for x in r['cases'])
