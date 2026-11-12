#!/usr/bin/env python3
"""Offline, disposable >30-commit proof; only deterministic synthetic credentials.
Run from the checkout: python3 scripts/manual/gitleaks-range-3745/prove.py /absolute/gitleaks
No downloads, GitHub calls, accounts or changes to the caller's history/config.
"""
import json
import os
from pathlib import Path
import random
import re
import shutil
import string
import subprocess
import sys
import tempfile

scanner = str(Path(sys.argv[1]).resolve())
source = Path.cwd()
git_version = subprocess.check_output(["git", "--version"], text=True).strip()
parts = re.search(r"(\d+)\.(\d+)", git_version)
if not parts or tuple(map(int, parts.groups())) < (2, 36):
    raise SystemExit("Proof requires Git >=2.36 for remerge diffs; got " + git_version)
work = source / ".artifacts" / "gitleaks-range-3745"
work.mkdir(parents=True, exist_ok=True)
env = {**os.environ, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
       "GIT_AUTHOR_NAME": "Inert fixture", "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
       "GIT_COMMITTER_NAME": "Inert fixture", "GIT_COMMITTER_EMAIL": "fixture@example.invalid"}
with tempfile.TemporaryDirectory(prefix="proof-", dir=work) as name:
    repo = Path(name)
    def git(*args):
        return subprocess.check_output(["git", *args], cwd=repo, env=env, text=True).strip()
    git("init", "-q")
    for filename in [".gitleaks.toml", ".gitleaksignore"]:
        shutil.copyfile(source / filename, repo / filename)
    target = repo / "fixture.txt"
    target.write_text("base\n")
    git("add", ".")
    git("-c", "commit.gpgsign=false", "commit", "-qm", "base")
    base = git("rev-parse", "HEAD")
    rng = random.Random(3745)
    # Repeated-c control is intentionally below the default entropy threshold.
    # This seeded, non-credential value exercises the real default token rule.
    fake = "ghp_" + "".join(rng.choice(string.ascii_letters + string.digits) for _ in range(36))
    commits = []
    for i in range(1, 38):
        target.write_text(f"inert fixture commit {i}\n" + (f'github_token = "{fake}"\n' if i == 36 else ""))
        git("add", "fixture.txt")
        git("-c", "commit.gpgsign=false", "commit", "-qm", f"inert fixture {i}")
        commits.append(git("rev-parse", "HEAD"))
    def scan(label, opts):
        report = repo / "report.json"
        result = subprocess.run([scanner, "detect", "--redact", "--no-banner", "--exit-code=2",
                                 "--config=.gitleaks.toml", "--gitleaks-ignore-path=.gitleaksignore",
                                 "--report-format=json", f"--report-path={report}", f"--log-opts={opts}"],
                                cwd=repo, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        findings = json.loads(report.read_text())
        print(json.dumps({"case": label, "exit": result.returncode, "findings": len(findings),
                          "range": opts, "head": git("rev-parse", opts.split()[-1].split("..")[-1]),
                          "commits": int(git("rev-list", "--count", opts.split()[-1]))}))
        return result.returncode, findings
    old, old_findings = scan("old-first-page", f"--no-merges --first-parent {commits[0]}^..{commits[29]}")
    assert old == 0 and old_findings == []
    code, findings = scan("full-range", base + ".." + commits[-1])
    assert code == 2 and len(findings) == 1 and findings[0]["Commit"] == commits[35]
    # Prove the new workflow's helper (not just a separately built range) catches it.
    bindir = repo / "bin"
    bindir.mkdir()
    (bindir / "gitleaks").symlink_to(scanner)
    result = subprocess.run(["bash", str(source / "scripts/ci/gitleaks-pr.sh")], cwd=repo,
                            env={**env, "PATH": str(bindir) + os.pathsep + env["PATH"],
                                 "PR_BASE_SHA": base, "PR_HEAD_SHA": commits[-1]},
                            text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    assert result.returncode == 2 and base + ".." + commits[-1] in result.stdout
    print(json.dumps({"case": "production-helper", "exit": result.returncode, "commits": 37, "exactHead": True}))
    # Exact fingerprint ignores still apply; a later identical fake is not hidden.
    with (repo / ".gitleaksignore").open("a") as out:
        out.write("\n" + findings[0]["Fingerprint"] + "\n")
    code, findings = scan("fingerprint-control", base + ".." + commits[-1])
    assert code == 0 and not findings
    target.write_text(f'github_token = "{fake}"\n')
    git("add", "fixture.txt")
    git("-c", "commit.gpgsign=false", "commit", "-qm", "unrelated new occurrence")
    code, findings = scan("new-occurrence-control", base + "..HEAD")
    assert code == 2 and len(findings) == 1
    # Only the merge resolution contains this second occurrence. The side branch
    # itself has no secret. git log without --diff-merges silently skips it.
    first = git("rev-parse", "HEAD")
    side = git("commit-tree", git("rev-parse", base + "^{tree}"), "-p", base, "-m", "inert side")
    (repo / "merge-only.txt").write_text(f'github_token = "{fake}"\n')
    git("add", "merge-only.txt")
    merged = git("commit-tree", git("write-tree"), "-p", first, "-p", side, "-m", "merge resolution")
    # The full-range scanner should see the resolution's occurrence in addition
    # to the unignored new-occurrence control above.
    code, findings = scan("merge-resolution-control", "--diff-merges=remerge " + base + ".." + merged)
    assert code == 2 and any(f["Commit"] == merged for f in findings)
    result = subprocess.run(["bash", str(source / "scripts/ci/gitleaks-pr.sh")], cwd=repo,
                            env={**env, "PATH": str(bindir) + os.pathsep + env["PATH"],
                                 "PR_BASE_SHA": base, "PR_HEAD_SHA": merged},
                            text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    sarif = json.loads((repo / "results.sarif").read_text())
    assert result.returncode == 2 and any(r["partialFingerprints"]["commitSha"] == merged
                                          for r in sarif["runs"][0]["results"])
print("PASS: 6 real-scanner controls; owned temporary repository removed")

# A base sync must not duplicate existing findings under the merge fingerprint.
with tempfile.TemporaryDirectory(prefix="merge-proof-", dir=work) as name:
    repo = Path(name)
    git("init", "-q")
    for filename in [".gitleaks.toml", ".gitleaksignore"]:
        shutil.copyfile(source / filename, repo / filename)
    (repo / "conflict.txt").write_text("initial\n")
    git("add", ".")
    git("-c", "commit.gpgsign=false", "commit", "-qm", "initial")
    root = git("rev-parse", "HEAD")
    (repo / "base-secret.txt").write_text(f'github_token = "{fake}"\n')
    git("add", ".")
    git("-c", "commit.gpgsign=false", "commit", "-qm", "inert finding on base")
    base_with_finding = git("rev-parse", "HEAD")
    code, findings = scan("base-finding-control", root + "..HEAD")
    assert code == 2 and len(findings) == 1
    with (repo / ".gitleaksignore").open("a") as out:
        out.write("\n" + findings[0]["Fingerprint"] + "\n")
    git("add", ".gitleaksignore")
    git("-c", "commit.gpgsign=false", "commit", "-qm", "exact ignored synthetic finding")
    base_tip = git("rev-parse", "HEAD")
    git("checkout", "-qb", "feature", root)
    (repo / "feature.txt").write_text("feature\n")
    git("add", ".")
    git("-c", "commit.gpgsign=false", "commit", "-qm", "feature")
    git("-c", "commit.gpgsign=false", "merge", "--no-edit", base_tip)
    clean_head = git("rev-parse", "HEAD")
    code, findings = scan("bad-first-parent-sync-control", "--diff-merges=first-parent " + base_tip + "..HEAD")
    assert code == 2 and len(findings) == 1 and findings[0]["Commit"] == clean_head
    code, findings = scan("clean-remerge-sync", "--diff-merges=remerge " + base_tip + "..HEAD")
    assert code == 0 and not findings
    bindir = repo / "bin"
    bindir.mkdir()
    (bindir / "gitleaks").symlink_to(scanner)
    def helper(base_sha, head_sha):
        return subprocess.run(["bash", str(source / "scripts/ci/gitleaks-pr.sh")], cwd=repo,
                              env={**env, "PATH": str(bindir) + os.pathsep + env["PATH"],
                                   "PR_BASE_SHA": base_sha, "PR_HEAD_SHA": head_sha},
                              text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    assert helper(base_tip, clean_head).returncode == 0
    git("checkout", "-qb", "resolution-base")
    (repo / "conflict.txt").write_text("base edit\n")
    git("add", "conflict.txt")
    git("-c", "commit.gpgsign=false", "commit", "-qm", "base edit")
    resolution_base = git("rev-parse", "HEAD")
    git("checkout", "-qb", "resolution-feature", clean_head)
    (repo / "conflict.txt").write_text("feature edit\n")
    git("add", "conflict.txt")
    git("-c", "commit.gpgsign=false", "commit", "-qm", "feature edit")
    conflict = subprocess.run(["git", "merge", "--no-edit", resolution_base], cwd=repo, env=env,
                              text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    assert conflict.returncode == 1 and "CONFLICT" in conflict.stdout
    (repo / "conflict.txt").write_text(f'github_token = "{fake}"\n')
    git("add", "conflict.txt")
    git("-c", "commit.gpgsign=false", "commit", "-qm", "inert secret in conflict resolution")
    resolved_head = git("rev-parse", "HEAD")
    code, findings = scan("resolution-secret", "--diff-merges=remerge " + resolution_base + "..HEAD")
    assert code == 2 and len(findings) == 1 and findings[0]["Commit"] == resolved_head
    assert helper(resolution_base, resolved_head).returncode == 2
    objects = repo / ".git" / "objects"
    mode = objects.stat().st_mode
    try:
        objects.chmod(0o500)
        failed = helper(resolution_base, resolved_head)
        assert failed.returncode != 0 and "unable to create temporary object directory" in failed.stdout
        print(json.dumps({"case": "remerge-object-write-error", "exit": failed.returncode, "failsClosed": True}))
    finally:
        objects.chmod(mode)
print("PASS: base-sync, conflict-resolution and real remerge-error controls; owned repositories removed")
