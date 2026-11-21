#!/usr/bin/env python3
"""Owned Linux CPU-contention rehearsal. No provider/daemon calls; never retries a failed run."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

EXPECTED_RESTART_CASE = "a new FleetManager reconstructs the expired journal and starts again from the same private state"

def read_restart_cases(report):
    try:
        details = json.loads(report.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("Missing or invalid Vitest report") from error
    if not isinstance(details, dict) or not isinstance(details.get("testResults"), list):
        raise ValueError("Vitest report must contain test results")
    cases = []
    for suite in details["testResults"]:
        if not isinstance(suite, dict) or not isinstance(suite.get("assertionResults"), list):
            raise ValueError("Vitest suite must contain assertion results")
        cases.extend(suite["assertionResults"])
    if (len(cases) != 1 or not isinstance(cases[0], dict)
            or cases[0].get("fullName") != EXPECTED_RESTART_CASE or cases[0].get("status") != "passed"):
        raise ValueError("Expected exactly one passed company-join restart case")
    case = cases[0]
    return [{"name": case["fullName"], "status": case["status"], "milliseconds": case.get("duration")}]

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("serial",), default="serial")
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--load", type=int, default=4)
    parser.add_argument("--cpu", type=int, default=None)
    parser.add_argument("--out", default=".artifacts/m3499/contention")
    args = parser.parse_args()
    if not hasattr(os, "sched_getaffinity"):
        parser.error("requires Linux CPU affinity")
    if args.runs < 1 or args.load < 0:
        parser.error("runs must be positive; load must be nonnegative")
    available = os.sched_getaffinity(0)
    cpu = min(available) if args.cpu is None else args.cpu
    if cpu not in available:
        parser.error("selected CPU is outside this process affinity")
    os.sched_setaffinity(0, {cpu})
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    files = ["tests/hub-company-join-restart.test.ts"]
    vitest = Path("node_modules/vitest/vitest.mjs")
    if not vitest.exists():
        vitest = Path("../../node_modules/vitest/vitest.mjs")
    pattern = EXPECTED_RESTART_CASE
    def stop(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    load = []
    records = []
    try:
        for _ in range(args.load):
            load.append(subprocess.Popen([sys.executable, "-c", "while True: pass"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        for index in range(1, args.runs + 1):
            report = out / f"run-{index}.json"
            report.unlink(missing_ok=True)  # a prior invocation cannot stand in for a missing fresh report
            scheduling = ["--config=vitest.config.durable.ts"]
            command = ["node", str(vitest), "run", *files, "-t", pattern, *scheduling, "--reporter=json", f"--outputFile={report}"]
            started = time.monotonic()
            child = None
            try:
                with (out / f"run-{index}.log").open("w") as log:
                    child = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                    result = child.wait()
            finally:
                if child is not None and child.poll() is None:
                    os.killpg(child.pid, signal.SIGTERM)
                    child.wait()
            cases = read_restart_cases(report)
            records.append({"run": index, "mode": args.mode, "cpu": cpu, "busyProcesses": args.load,
                            "seconds": round(time.monotonic() - started, 3), "exit": result, "cases": cases})
            (out / "summary.json").write_text(json.dumps(records, indent=2) + "\n")
            print(json.dumps(records[-1]), flush=True)
            if result:
                sys.exit(result)  # stop; do not convert a failed sample into a retry
    finally:
        for process in load:
            process.terminate()
        for process in load:
            process.wait()


if __name__ == "__main__":
    main()
