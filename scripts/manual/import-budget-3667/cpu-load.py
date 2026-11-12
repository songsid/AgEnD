#!/usr/bin/env python3
"""Run a real selected Vitest case under owned, CPU-affined contention.

Pass a baseline worktree to observe the cold import's 10s failure, or the fixed
worktree for the same assertion passing. No test timeout or source is changed.
"""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument("repo", type=Path)
parser.add_argument("--burners", type=int, default=8)
parser.add_argument("--log", type=Path, required=True)
args = parser.parse_args()
if not 1 <= args.burners <= 16:
    parser.error("--burners must be between 1 and 16")
repo = args.repo.resolve()
core = min(os.sched_getaffinity(0))
burners = []
started = time.monotonic()
try:
    for _ in range(args.burners):
        burners.append(subprocess.Popen(
            ["taskset", "-c", str(core), sys.executable, "-c", "while True: pass"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
    with args.log.open("w") as log:
        result = subprocess.run([
            "taskset", "-c", str(core), "node", "node_modules/vitest/vitest.mjs", "run",
            "tests/agy-model-effort-1825.test.ts", "-t", "the instance's model, else",
        ], cwd=repo, stdout=log, stderr=subprocess.STDOUT, timeout=180)
    print({"exit": result.returncode, "seconds": round(time.monotonic() - started, 2),
           "core": core, "burners": len(burners)})
finally:
    for child in burners:
        child.terminate()
    for child in burners:
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
sys.exit(result.returncode)
