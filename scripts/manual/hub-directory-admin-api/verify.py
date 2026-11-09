#!/usr/bin/env python3
"""Focused inert reversals. Do not run concurrently with tests, types or another source writer."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[3]
control = 'src/hub/settings-directory-control.ts'
http = 'src/hub/settings-directory-http.ts'
runtime = 'src/hub/runtime.ts'
server = 'src/hub/compose/server.ts'
fleet = 'src/fleet-manager.ts'
http_compose = 'src/hub/http/compose.ts'
unit = ['tests/hub-directory-settings-control.test.ts']
http_tests = ['tests/hub-compose.test.ts', '-t', 'configured administrator AD settings HTTP']
loan = ['tests/hub-compose.test.ts', '-t', 'directory Save decision borrowing']
fm = ['tests/hub-settings-fleet-m2682.test.ts', '-t', 'lazy directory controller|Stop during the lazy import']
# Every row changes one guard/forwarding site. Source is restored between rows, not just at the end.
rows = [
 ('read-admin', control, 'if (ctx.actor.kind === "hub-administrator" && !same(ctx.actor.person, s.administrator))', 'if (false)', unit),
 ('mounted-hub', control, ' || m.decision.hubId !== deps.hubId', '', unit),
 ('write-only-reference', control, 'const { bindPasswordRef: _ref, ...directory } = structuredClone(s.config);', 'const directory = structuredClone(s.config);', unit),
 ('strict-request', control, 'const prepareRequest = z.strictObject(', 'const prepareRequest = z.object(', unit),
 ('strict-directory', control, 'const editable = z.strictObject(', 'const editable = z.object(', unit),
 ('actor-snapshot', control, 'actor: structuredClone(input.actor)', 'actor: input.actor', unit),
 ('physical-drain', control, 'await Promise.allSettled([...active]);', '', unit),
 ('permanent-fence', control, 'stopped = true; save.fence();', 'stopped = false; save.fence();', unit),
 ('notice-recipient', control, 'person: { ...s.administrator }', 'person: { realm: s.administrator.realm, objectId: "11111111-1111-4111-8111-111111111111" }', unit),
 ('secret-change-notice', control, 'if (request.bindPassword !== undefined) changes.push("secret");', 'if (false) changes.push("secret");', unit),
 ('disconnect', http, '!disconnected && q.ctx.current() === true', 'q.ctx.current() === true', http_tests),
 ('post-factory', http, 'const control = await invoke(create);\n    q.signedIn(); if (!current()) throw new HubProtocolError("revoked");', 'const control = await invoke(create);\n    q.signedIn();', http_tests),
 ('factory-refusal', http, 'const control = await invoke(create);', 'const control = await create();', http_tests),
 ('session-mark', http_compose, '...(deps.directorySettings ? [HUB_DIRECTORY_SETTINGS_FEATURE] : [])];', '...[]];', http_tests),
 ('entry-mark', http_compose, '...(deps.directoryNotices ? ["directory-security-notices-v1"] : []), ...(deps.directorySettings ? [HUB_DIRECTORY_SETTINGS_FEATURE] : [])]),', '...(deps.directoryNotices ? ["directory-security-notices-v1"] : [])]),', http_tests),
 ('runtime-forward', runtime, '          ...(options.directorySettings ? { directorySettings: options.directorySettings } : {}),', '', http_tests),
 ('factory-forward', server, '        ...(options.directorySettings ? { directorySettings: options.directorySettings } : {}),', '', http_tests),
 ('fleet-forward', fleet, '        directorySettings: () => this.hubDirectorySettings(),', '', fm),
 ('fleet-import-fence', fleet, 'if (!mounted || this.shuttingDown || runtime !== this.hubRuntime) throw Error("The Hub directory changed");', 'if (!mounted) throw Error("The Hub directory changed");', fm),
 ('loan-ticket', runtime, '!this.stopped && ticket === this.admissionTicket && current() === true', '!this.stopped && current() === true', loan),
 ('loan-scope', runtime, 'if (!open || !owned()) throw Error("Directory decision owner changed");', 'if (!owned()) throw Error("Directory decision owner changed");', loan),
 ('loan-sync', runtime, 'if (result && (typeof result === "object" || typeof result === "function") && typeof (result as { then?: unknown }).then === "function") {', 'if (false && result && (typeof result === "object" || typeof result === "function") && typeof (result as { then?: unknown }).then === "function") {', loan),
 ('admin-acquisition', http, 'const actor = await q.ctx.requireAdmin();', 'const actor = { kind: "directory" as const, person: { realm: "corp", objectId: "11111111-1111-4111-8111-111111111111" }, sessionId: "fixture" };', http_tests),
 ('csrf', http, 'q.signedIn(); if (action) q.csrf();', 'q.signedIn();', http_tests),
 ('query', http, 'if (q.query.size)', 'if (false)', http_tests),
]
selected = set(sys.argv[1:])
if selected - {row[0] for row in rows}:
    raise RuntimeError('unknown reversal name')
original = {name: (root / name).read_bytes() for name in {row[1] for row in rows}}
out = root / '.artifacts/hub-directory-admin-api'
out.mkdir(parents=True, exist_ok=True)
results = []
try:
    for name, path, old, new, args in rows:
        if selected and name not in selected:
            continue
        target = root / path
        text = original[path].decode()
        if text.count(old) != 1:
            raise RuntimeError(f'{name}: expected one pattern, found {text.count(old)}')
        target.write_text(text.replace(old, new))
        report_file = out / f'{name}.json'
        try:
            with (out / f'{name}.log').open('w') as log:
                result = subprocess.run(['npx', 'vitest', 'run', *args, '--reporter=json', f'--outputFile={report_file}'], cwd=root, stdout=log, stderr=subprocess.STDOUT)
            data = json.loads(report_file.read_text())
            row = {'name': name, 'file': path, 'exit': result.returncode, 'passed': data['numPassedTests'], 'failed': data['numFailedTests'], 'deselected': data['numPendingTests']}
            results.append(row)
            print(json.dumps(row), flush=True)
        finally:
            target.write_bytes(original[path])
finally:
    for path, contents in original.items():
        (root / path).write_bytes(contents)
    receipt = {'baseline': {hashlib.sha256(contents).hexdigest(): path for path, contents in original.items()}, 'rows': results,
               'restored': all((root / path).read_bytes() == contents for path, contents in original.items())}
    suffix = '-' + '-'.join(sorted(selected)) if selected else ''
    (out / f'mutations{suffix}.json').write_text(json.dumps(receipt, indent=2) + '\n')
if any(row['exit'] == 0 or row['failed'] == 0 for row in results):
    raise RuntimeError('one or more reversals were not assertion-caught')
