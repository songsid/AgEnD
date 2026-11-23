#!/usr/bin/env python3
"""Owned Linux Office smoke contention proof; stop on failure, never retry a sample."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

CASE = "desk-light-en"
REQUIRED = {
    "mounted", "toggle:shown", "toggle:on by default", "person found",
    "carried: someone is drawn at the pointer (the spot differs from before the drag)",
    "drop: no card opens", "they walk off the drop point", "card: Pat and Feed",
    "local only: no request but a GET while dragging, patting and feeding",
    "tell: off by default", "tell on: one POST /ui/office-tell per pat",
    "tell on: queued as [Office] … patted your head (for the next message)",
    "tell off again: nothing sent", "pat words: card is closed before toggle",
    "toggle off: kept here", "toggle off: no Pat/Feed", "noOverflow", "noPageErrors",
    "pointer clock: live before gesture",
}
SOURCES = [
    "scripts/manual/test-office-play-contention-m3551.py",
    "scripts/manual/test-office-play-contention-m3551_test.py",
    "scripts/manual/smoke/smoke-office-play-m3293.mts",
    "scripts/manual/smoke-fixture/office-smoke-card.ts", "scripts/manual/smoke-fixture/office-smoke-pointer.ts",
    "scripts/manual/smoke-fixture/index.mts", "scripts/manual/smoke-fixture/from-defaults.mts",
    "scripts/manual/smoke-fixture/public-roster.mts",
    "scripts/manual/smoke-fixture/office-capture-cases.ts",
    "src/ui/fleet-office.js", "src/ui/fleet-office-card.js", "src/ui/fleet-office-play.js",
    "src/ui/fleet-office-zones.js", "src/ui/fleet-canvas-view.js",
    "src/ui/shared/signin.js", "src/ui/signin.html",
]

def read_result(path):
    try:
        result = json.loads(Path(path).read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("Missing or invalid smoke report") from error
    if not isinstance(result, dict) or result.get("pass") is not True:
        raise ValueError("Smoke did not pass")
    cases = result.get("cases")
    if not isinstance(cases, dict) or set(cases) != {CASE}:
        raise ValueError("Expected exactly the intended English behavioral case")
    case = cases[CASE]
    if not isinstance(case, dict) or set(case) != REQUIRED:
        raise ValueError("Missing/extra/failed behavioral checks")
    for key, value in case.items():
        if value is not True and not (isinstance(value, dict) and value.get("pass") is True):
            raise ValueError("Behavioral check did not pass: " + key)
    return {"case": CASE, "checks": len(case), "passed": True,
            "sha256": hashlib.sha256(Path(path).read_bytes()).hexdigest()}

def source_hashes():
    return {p: hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in SOURCES}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=30)
    parser.add_argument("--load", type=int, default=2)
    parser.add_argument("--out", default=".artifacts/m3551/contention")
    args = parser.parse_args()
    if not hasattr(os, "sched_getaffinity") or args.runs < 1 or args.load < 0:
        parser.error("requires Linux affinity, positive runs and nonnegative load")
    for name in ("REPO", "PW_DIR", "CHROME"):
        if not os.environ.get(name): parser.error("missing environment: " + name)
    if Path(os.environ["REPO"]).resolve() != Path.cwd().resolve(): parser.error("REPO must be this checkout")
    cpu = min(os.sched_getaffinity(0)); os.sched_setaffinity(0, {cpu})
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    subprocess.run(["git", "diff", "--exit-code", "HEAD", "--", *SOURCES], check=True, stdout=subprocess.DEVNULL)
    hashes = source_hashes()
    out = Path(args.out).resolve(); out.mkdir(parents=True, exist_ok=True)
    summary = {"sourceHead": head, "sourceHashes": hashes, "cpu": cpu, "busyProcesses": args.load,
               "selector": CASE, "captureOnly": False, "wordsOnly": False, "runs": []}
    def stop(_signal, _frame): raise KeyboardInterrupt
    signal.signal(signal.SIGINT, stop); signal.signal(signal.SIGTERM, stop)
    loads = []
    try:
        for _ in range(args.load):
            loads.append(subprocess.Popen([sys.executable, "-c", "while True: pass"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        for index in range(1, args.runs + 1):
            if source_hashes() != hashes or subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip() != head:
                raise RuntimeError("Source changed during proof")
            if any(p.poll() is not None for p in loads): raise RuntimeError("An owned contention process exited")
            run_out = out / f"run-{index}"; run_out.mkdir(exist_ok=True)
            report = run_out / "smoke-office-play-m3293/result.json"; report.unlink(missing_ok=True)
            env = dict(os.environ, OUT=str(run_out), M3513_CASE=CASE, M3513_CAPTURE_ONLY="0", M3513_WORDS_ONLY="0")
            command = ["node", "--import", "tsx", "scripts/manual/smoke/smoke-office-play-m3293.mts"]
            started, child = time.monotonic(), None
            try:
                with (out / f"run-{index}.log").open("w") as log:
                    child = subprocess.Popen(command, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                    code = child.wait()
            finally:
                if child is not None and child.poll() is None:
                    os.killpg(child.pid, signal.SIGTERM); child.wait()
            row = {"run": index, "exit": code, "seconds": round(time.monotonic() - started, 3)}
            try:
                if code: raise ValueError("Smoke process failed")
                row["result"] = read_result(report)
            except ValueError as error:
                row["error"] = str(error)
            summary["runs"].append(row)
            (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
            print(json.dumps(row), flush=True)
            if "error" in row: return 1
    finally:
        for p in loads: p.terminate()
        for p in loads: p.wait()
    return 0

if __name__ == "__main__": sys.exit(main())
