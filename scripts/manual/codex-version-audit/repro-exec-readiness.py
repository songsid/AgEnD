#!/usr/bin/env python3
"""Observe Linux's argv-before-environ exec window using owned fake sleeps, never Codex/tmux.

Large inert environment entries widen create_elf_tables' environment walk. This is an observational probe,
not a timing assertion for CI; the held-exec regression in codex-version-audit-rig.test.ts is deterministic.
"""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--runs", type=int, default=100, choices=range(1, 1001), metavar="1..1000")
args = parser.parse_args()
if not Path("/proc/self/environ").exists():
    parser.error("Linux procfs is required")
empty = 0
with tempfile.TemporaryDirectory(prefix="agend-exec-probe-") as scratch:
    # No inherited account/provider secrets, and every child is killed and reaped by its owning Popen.
    env = {"PATH": "/usr/bin:/bin", "HOME": scratch, "CODEX_HOME": scratch + "/fake"}
    env.update({f"PADDING_{i}": "x" * 16384 for i in range(40)})
    expected = ("CODEX_HOME=" + env["CODEX_HOME"]).encode()
    for _ in range(args.runs):
        child = subprocess.Popen(["bash", "--noprofile", "--norc", "-c",
                                  "exec -a codex-app-server-fake sleep 60"], env=env)
        try:
            deadline = time.monotonic() + 5
            cmdline = Path(f"/proc/{child.pid}/cmdline")
            environ = Path(f"/proc/{child.pid}/environ")
            while not cmdline.read_bytes().startswith(b"codex-app-server-fake\0"):
                if time.monotonic() >= deadline:
                    raise RuntimeError("owned fake did not exec")
            first = environ.read_bytes()
            if not first:
                empty += 1
            while expected not in environ.read_bytes().split(b"\0"):
                if time.monotonic() >= deadline:
                    raise RuntimeError("owned fake's environment never became readable")
                time.sleep(0.001)
        finally:
            child.kill()
            child.wait()
print(json.dumps({"runs": args.runs, "cmdline_ready_but_environ_empty": empty,
                  "eventually_has_expected_CODEX_HOME": args.runs}))
