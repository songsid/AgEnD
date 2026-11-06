# Web-only fleet, end to end (#2910)

A fleet with **no Discord or Telegram connection**, driven the way a web-only person uses it — through the dashboard's
own routes — with **real** Claude Code and Codex CLIs against mock model APIs (no account, no network at run time).

What `drive.mjs` checks, in order:

0. `/signin` is marked web-only; `agend web --code` from this computer signs in as **this computer's admin** (verified).
1. **New agent** from the web is applied by the browser itself (no `agend settings confirm`), running, with no topic.
2. A **schedule** made from the web fires and reaches `lead`.
3. **Agents message each other** (`lead` → `worker`, `send_to_instance`).
4. A **Notice**: `worker`'s CLI is killed, and its crash is listed in Notices (unread).
5. **Claude Code's own permission dialog** (`lead` asks before acting) answered from the web: **Yes** runs the
   command, **No** does not.
6. **Codex's own approval dialog** (`coder` asks before acting; the mock asks to run `echo probe` with escalation) answered from the web: **Yes** runs it, **No** does not.

## Run

Prerequisites: Docker; an image with Node 22 and tmux (`IMAGE`; a user `rh` is created if it has none); a Claude Code
executable (`CLAUDE_BIN`); the codex binary (`CODEX_BIN`, e.g. from `npm install --prefix <scratch> @openai/codex@<v>`:
`<scratch>/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`).

```bash
S=scripts/manual/web-only-e2e/run.sh
$S build <sha> branch            # network only here (npm ci)
IMAGE=… CLAUDE_BIN=… CODEX_BIN=… $S start branch
$S drive branch                  # the table, RESULT PASS / FAIL
$S collect branch; $S stop branch
```

The container runs with `--network none --memory=3g` and no host mounts; nothing on the host is touched (no fleet is
started on the host, no real account is used).

Notes:

- Claude Code 2.1.30x defaults to **auto mode** (it runs what it judges low-risk without asking), so `lead`'s project
  sets `permissions.defaultMode: "default"` — as a person who wants to be asked would.
- `coder`'s Codex reads the mock provider from `~/.codex/config.toml` (AgEnD copies it into the instance's home).
- The mocks: `mock-anthropic.mjs` and `mock-codex.mjs` (here; every Codex turn asks to run `echo probe` with escalation).
- `lead` also allows AgEnD's own tools (`mcp__agend`): asked about Bash, not about replying.
