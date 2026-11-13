import hashlib, json, os, pathlib, subprocess, time

root = pathlib.Path.cwd()
source = root / "src/hub/member/room-ask.ts"
folder = root / ".artifacts/room-ask-track-c/mutations"
folder.mkdir(parents=True, exist_ok=True)
original = source.read_bytes()
text = original.decode()
test_hash = hashlib.sha256((root / "tests/hub-room-ask-track-c.test.ts").read_bytes()).hexdigest()
cases = [
    ("R1-replay-payload", 'if (JSON.stringify(saved.ask) !== JSON.stringify(ask))', 'if (false)'),
    ("R2-local-lifecycle", ' && local.token === was.token', ''),
    ("R3-input-intent", 'this.save(id, "input", saved); return current();', 'return current();'),
    ("R4-exact-answer-ack", ' || saved.answer?.answerId !== ack.answerId', ''),
    ("R5-recover-input", 'if (row.state === "input") this.save(row.message_id, "held", saved);', 'if (row.state === "input") this.save(row.message_id, "queued", saved);'),
    ("R6-once-before-input", ' || this.row(id)?.state !== "dispatching"', ''),
    ("R7-frozen-answer-id", 'source.sendAnswer(structuredClone(saved.answer!))', 'source.sendAnswer({ ...saved.answer!, answerId: randomUUID() })'),
    ("R8-held-presence-fence", '\n      if (!current(source)) return;\n      if (!options.exposures()', '\n      if (!options.exposures()'),
    ("R9-presence-dedupe", 'if (sent.get(entry.exposureId) === value) continue;', ''),
    ("R10-context-reply-bound", '.refine(rows => rows.length <= 30 || rows.filter(r => r.repliedTo).length === 1)', ''),
    ("R11-current-room-capability", '\n      && !!source.features?.has("welcome-caps-v1") && source.features.has(ROOM_ASK_CAPABILITY);', '\n      && !!source.features?.has("welcome-caps-v1");'),
    ("R12-presence-room-capability", '\n    && !!source.features?.has("welcome-caps-v1") && source.features.has(ROOM_ASK_CAPABILITY);', '\n    && !!source.features?.has("welcome-caps-v1");'),
    ("R13-dispatch-teardown", '      if (this.closed) return;\n      const latest = this.row(id);', '      const latest = this.row(id);', 2),
    ("R14-report-teardown", '!this.closed && this.row(row.message_id)?.state === "acked"', 'this.row(row.message_id)?.state === "acked"'),
    ("R15-wakeable-sleep", 'if (input.process === "paused" && (input.pauseReason === "idle" || input.pauseReason === "warm_cap")) return { state: "idle" };', ''),
    ("R16-crash-normalization", 'if (input.process === "stopped" || input.process === "crashed") return { state: "paused", reason: "stopped" };', 'if (input.process === "stopped" || input.process === "crashed") return { state: "paused", reason: "crashed" };'),
    ("R17-viewer-reason", 'return { state: "paused", reason: reason === "idle" || reason === "warm_cap" ? "unknown" : reason };', 'return { state: "paused" };'),
]
results = []
try:
    for case in cases:
        name, before, after, *counts = case
        expected = counts[0] if counts else 1
        if os.getloadavg()[0] > 10:
            raise RuntimeError("load above10; mutation campaign paused before next case")
        assert text.count(before) == expected, (name, text.count(before))
        changed = text.replace(before, after)
        source.write_text(changed)
        with (folder / f"{name}-types.log").open("w") as out:
            typed = subprocess.run(["nice", "-n", "10", "node_modules/@typescript/typescript-linux-x64/lib/tsc", "--noEmit"], stdout=out, stderr=subprocess.STDOUT)
        with (folder / f"{name}-test.log").open("w") as out:
            tested = subprocess.run(["nice", "-n", "10", "node_modules/.bin/vitest", "run", "--no-file-parallelism", "tests/hub-room-ask-track-c.test.ts"], stdout=out, stderr=subprocess.STDOUT)
        log = (folder / f"{name}-test.log").read_text()
        record = dict(name=name, sourceSha256=hashlib.sha256(changed.encode()).hexdigest(), compileExit=typed.returncode,
                      testExit=tested.returncode, assertionRed="AssertionError:" in log, load=os.getloadavg()[0])
        results.append(record)
        source.write_bytes(original)
        (folder / "summary.json").write_text(json.dumps(dict(baseline=hashlib.sha256(original).hexdigest(), testSha256=test_hash, cases=results, restored=source.read_bytes() == original), indent=2) + "\n")
        print(json.dumps(record), flush=True)
        if typed.returncode != 0 or tested.returncode == 0 or not record["assertionRed"]:
            raise RuntimeError("case did not produce the required compiling assertion red")
finally:
    source.write_bytes(original)
