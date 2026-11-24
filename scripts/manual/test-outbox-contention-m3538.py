#!/usr/bin/env python3
"""Owned one-CPU outbox crash-fixture rehearsal. Real scratch SQLite/child SIGKILL; no retries."""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

CASES = ["DeliveryOutbox pre-begin crash fixture recovers a pre-begin dispatch after SIGKILL when target stays stopped, then expires it visibly"]

def read_cases(report):
    try:
        details = json.loads(report.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("Missing or invalid Vitest report") from error
    if not isinstance(details, dict) or not isinstance(details.get("testResults"), list):
        raise ValueError("Missing suites")
    found = []
    for suite in details["testResults"]:
        if not isinstance(suite, dict) or not isinstance(suite.get("assertionResults"), list):
            raise ValueError("Missing assertions")
        for case in suite["assertionResults"]:
            if not isinstance(case, dict):
                raise ValueError("Invalid assertion")
            name, status = case.get("fullName"), case.get("status")
            if name in CASES:
                if status != "passed":
                    raise ValueError("Intended case did not pass")
                found.append({"name": name, "status": status, "milliseconds": case.get("duration")})
            elif status not in ("pending", "skipped"):
                raise ValueError("Unexpected executed case")
    if len(found) != len(CASES) or {c["name"] for c in found} != set(CASES):
        raise ValueError("Expected exactly the intended passed crash case")
    return found

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=30)
    parser.add_argument("--load", type=int, default=4)
    parser.add_argument("--out", default=".artifacts/m3538/contention")
    args = parser.parse_args()
    if not hasattr(os, "sched_getaffinity") or args.runs < 1 or args.load < 0:
        parser.error("requires Linux affinity, positive runs and nonnegative load")
    cpu = min(os.sched_getaffinity(0))
    os.sched_setaffinity(0, {cpu})
    out = Path(args.out); out.mkdir(parents=True, exist_ok=True)
    vitest = Path("node_modules/vitest/vitest.mjs")
    if not vitest.exists(): vitest = Path("../../node_modules/vitest/vitest.mjs")
    def stop(_signal, _frame): raise KeyboardInterrupt
    signal.signal(signal.SIGINT, stop); signal.signal(signal.SIGTERM, stop)
    loads, records = [], []
    try:
        for _ in range(args.load):
            loads.append(subprocess.Popen([sys.executable, "-c", "while True: pass"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        for index in range(1, args.runs + 1):
            report = out / f"run-{index}.json"; report.unlink(missing_ok=True)
            command = ["node", str(vitest), "run", "src/delivery-outbox.test.ts", "-t", "|".join(re.escape(n) for n in CASES),
                       "--config=vitest.config.durable.ts", "--reporter=json", f"--outputFile={report}"]
            started, child = time.monotonic(), None
            try:
                with (out / f"run-{index}.log").open("w") as log:
                    child = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                    code = child.wait()
            finally:
                if child is not None and child.poll() is None:
                    os.killpg(child.pid, signal.SIGTERM); child.wait()
            row = {"run": index, "cpu": cpu, "busyProcesses": args.load, "seconds": round(time.monotonic() - started, 3), "exit": code}
            try:
                if code: raise ValueError("Vitest process failed")
                row["cases"] = read_cases(report)
            except ValueError as error:
                row["error"] = str(error)
            records.append(row); (out / "summary.json").write_text(json.dumps(records, indent=2) + "\n")
            print(json.dumps(row), flush=True)
            if "error" in row: return 1  # stop, never retry a failed sample
    finally:
        for process in loads: process.terminate()
        for process in loads: process.wait()
    return 0

if __name__ == "__main__": sys.exit(main())
