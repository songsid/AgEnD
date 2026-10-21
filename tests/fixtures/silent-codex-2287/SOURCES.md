# Codex silent raw-paste timing (#2287 / #2301)

Captured with the real npm platform payload `@openai/codex@0.162.1-linux-x64`.
Native binary SHA256:
`628e35487d888a28f0427fc37501da529dd3d81fcbad7a2c3421c1e8670d92e1`.

Use `scripts/manual/silent-codex-2287/repro.py` and `mock.mjs` only in a
disposable Linux container with `--network none --memory=2g --memory-swap=2g
--cpus=2 --pids-limit=512`. The script refuses a non-container host, a missing
explicit sentinel (`AGEND_2287_REPRO=private-container`) or a network interface
other than loopback. It never invokes AgEnD. The container image supplies
Node/Python/tmux; the public npm archive is extracted at `/opt/codex-audit`
with its platform vendor subtree intact. Run the script as the container's
non-root `rh` user, with writable `/home/rh/cx2287`, and both scripts there.

The script uses a scratch HOME/CODEX_HOME/workdir, explicit private tmux
socket, an env-i CLI launch, and a loopback Responses provider with
requires_openai_auth=false. It makes one raw paste and one Enter, then captures
viewport/history and rollout observations at 0.1/0.5/1/3/5/10/65 seconds.
An immediate 80-line assistant response pushes the input echo out of view.
No real account, vendor API, live fleet or host tmux was used. Both runs'
private tmux servers/mock children were stopped; the container was stopped.

Two capture sets are deliberately distinct:

- `startup-*`: exploratory run that began at the first empty composer, before
  the Context footer appeared. No flushed matching rollout entry was visible
  at 0.1–3 seconds; at 5 seconds it existed but the viewport echo was gone.
  This is a startup/flush capture, not a claim that AgEnD's normal ready gate
  would admit that first frame.
- `ready-*`: reproducible script now waits for both empty composer and Context
  footer. The exact user entry already exists at 0.1 seconds, while the echo
  is absent from the viewport and remains in history. The same holds through
  65 seconds. This shows why merely waiting longer cannot guarantee a pane
  proof for a fast completed turn.

Normalization: replace only the scratch workdir with
`/tmp/silent-codex-2287/work`, trim line-end spaces and terminal padding blank
rows. Timeline observations are unmodified. The selected rollout keeps the
user `response_item` and task boundary records verbatim, with session_meta
reduced to id/cwd/cli_version/source and its scratch cwd normalized. Upstream
base instructions and the bulky mock assistant body are omitted.

These fixtures demonstrate a known proof limitation on main b93db72ce. Codex's
raw-text rollout is selected by cwd, without pane/session ownership; #1663
intentionally refuses to call such a match delivered. The existing consumed
watch applies to marked steer/native-queue messages, so a later consumed log
must be correlated by delivery_id rather than assumed to confirm raw paste.
The session-ownership solution is tracked in #2301 (milestone 2.4); this PR
changes only self-silent outcome/operator notification behavior.
