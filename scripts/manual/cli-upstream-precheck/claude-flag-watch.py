#!/usr/bin/env python3
"""claude-flag-watch.py: a read-only tripwire for Claude Code server flags that the binary precheck cannot see (M-3652).

Claude caches the server's feature flags in each profile's `.claude.json` (`cachedGrowthBookFeatures`). A flag can roll
out without a release, so the daily CLI watch (~/.agend/scripts/check-cli-versions.sh) runs this after its version
table and prints one WARN line per profile where a watched flag has turned up.

Watched flags:
  tengu_eager_brooks  From 2.1.331, a cold `--continue` compacts the conversation to a summary on its own, before any
                      "Resume this conversation?" prompt shows, so AgEnD cannot press Escape to keep the full context.
                      Remedy (decision B, only once this fires): pass `idleCompaction: false` in the settings AgEnD
                      writes for Claude instances; the prompt then comes back and AgEnD answers it with Escape.

It prints only a profile's name, the flag's name, and whether the flag is on. It prints no tokens, no account fields
and no other flag's value. It reads each file once and writes nothing.

  claude-flag-watch.py [CONFIG_FILE ...]   default: ~/.claude.json and ~/.agend/credential-profiles/claude-code/*/.claude.json
Exit 0 always (it must never block the schedule).
"""
import glob
import json
import os
import sys

WATCHED = {
    "tengu_eager_brooks": "a cold --continue compacts to a summary with no prompt; remedy: idleCompaction:false (M-3652)",
}


def default_files() -> list[str]:
    home = os.path.expanduser("~")
    files = [os.path.join(home, ".claude.json")]
    # One fixed depth, never a recursive scan of ~/.agend.
    files += sorted(glob.glob(os.path.join(home, ".agend", "credential-profiles", "claude-code", "*", ".claude.json")))
    return [f for f in files if os.path.isfile(f)]


def profile_name(path: str) -> str:
    parent = os.path.basename(os.path.dirname(os.path.abspath(path)))
    return "host ~/.claude.json" if os.path.abspath(path) == os.path.join(os.path.expanduser("~"), ".claude.json") else parent


def is_on(value: object) -> bool:
    if isinstance(value, dict):
        value = value.get("defaultValue", value.get("value", value))
    return value is True


def check(path: str) -> list[str]:
    name = profile_name(path)
    try:
        with open(path, encoding="utf-8") as f:
            features = json.load(f).get("cachedGrowthBookFeatures")
    except (OSError, ValueError, AttributeError):
        return [f"WARN claude-flags {name}: its .claude.json cannot be read; the flag tripwire skipped it"]
    if not isinstance(features, dict):
        return []
    return [
        f"WARN claude-flags {name}: server flag {flag} is present ({'on' if is_on(features[flag]) else 'not on'}) - {why}"
        for flag, why in WATCHED.items() if flag in features
    ]


def main(argv: list[str]) -> int:
    files = argv or default_files()
    lines = [line for path in files for line in check(path)]
    for line in lines:
        print(line)
    if not lines:
        print(f"claude-flags: none of {', '.join(WATCHED)} in {len(files)} profile(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
