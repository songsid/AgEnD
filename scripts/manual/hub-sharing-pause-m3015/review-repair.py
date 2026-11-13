"""Scoped R2 reversals; only own source, always restored, no external services."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
cases = [
    ("V1-version", "src/hub/sharing.ts", "state.revocationVersion++;", "void state;", "commits the authorization"),
    ("V2-refresh", "src/hub/sharing.ts", "    refresh();", "    void refresh;", "commits the authorization"),
    ("V3-final-proof", "src/hub/sharing.ts", "}, () => permit.assertCurrent());", "});", "rechecks the operational Resume proof"),
    ("H1-old-read", "src/ui/hub-chat-store.js", "const availabilityCurrent = availabilityEpoch === st.availabilityEpoch;", "const availabilityCurrent = true;", "keeps a learned pause"),
    ("L1-expiry", "src/hub/identity.ts", "lease.expiresAt <= expected.now || ", "", "issued-capability boundary.*expired"),
    ("V4-feature", "src/hub/http/compose.ts", 'deps.refreshAuthorization ? ["sharing-pause-v1"] : []', '["sharing-pause-v1"]', "refuses pause and omits its mark"),
]
results = []
for name, filename, before, after, selector in cases:
    if os.getloadavg()[0] > 10:
        raise RuntimeError("Pause before reversal: host load exceeds10")
    path = Path(filename); original = path.read_bytes(); source = original.decode()
    assert before in source, (name, "missing exact source")
    try:
        path.write_text(source.replace(before, after))
        typed = subprocess.run(["node", "node_modules/@typescript/native/bin/tsc", "--noEmit"], env={**os.environ, "GOMAXPROCS": "2"}, text=True, capture_output=True)
        (out / (name + "-types.log")).write_text(typed.stdout + typed.stderr)
        assert typed.returncode == 0, (name, "mutation must compile")
        suite = "tests/hub-sharing-pause-ui-m3015.test.ts" if name.startswith("H") else "tests/hub-sharing-pause-m3015.test.ts"
        run = subprocess.run(["node", "node_modules/vitest/vitest.mjs", "run", suite, "--maxWorkers=2", "-t", selector], text=True, capture_output=True)
        log = run.stdout + run.stderr; (out / (name + ".log")).write_text(log)
        caught = run.returncode != 0 and "AssertionError" in log
        results.append({"id": name, "path": filename, "selector": selector, "nativeCompilerExit": typed.returncode,
            "exit": run.returncode, "semanticCaught": caught, "originalDigest": hashlib.sha256(original).hexdigest()})
        assert caught, (name, "reversal survived or failed outside an assertion")
    finally:
        path.write_bytes(original)
        assert path.read_bytes() == original
        (out / "receipt.json").write_text(json.dumps({"results": results, "exactRestore": True}, indent=2) + "\n")
print(json.dumps({"caught": len(results), "exactRestore": True}))
