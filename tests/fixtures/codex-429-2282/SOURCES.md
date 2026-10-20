# Codex retry exhaustion / quota, 2026-10-21 (UTC+8)

Real `codex-cli0.163.0`, fetched from the official `@openai/codex` npm artifact through
`check-cli-versions.sh --download codex 0.163.0 <scratch>`; no host installation/update.
Native binary SHA256: `399ff69c431c066e40de318fba45c2b07f45a76b19939d247ee4828fc70c4215`.
The reporter's CLI/AgEnD versions remain unknown; these captures prove this mechanism on0.163.0.

A disposable `agend-rh-225-bus:latest` container, `--network none --memory2g --memory-swap2g --cpus2 --pids-limit512`,
ran the binary directly as non-root `rh`. Scratch `/home/rh/cx/home` and `/home/rh/cx/code` (HOME/CODEX_HOME),
workspace `/home/rh/cx/work`, private explicit tmux socket `/home/rh/cx/t.sock`,140×38. No fleet/daemon handler,
host tmux, real account, auth symlink, vendor endpoint or host CLI was used. The container is stopped.

Only fixture normalization: replace `/home/rh/cx/work` with `/tmp/codex-429-audit/work`, trim trailing spaces.
Blank terminal rows are retained with a path-scoped whitespace attribute. No error text was invented or edited.

The existing [Responses mock](../../../scripts/manual/codex-version-audit/mock.mjs) was extended with `e429` and
`insufficient` modes. It binds127.0.0.1:18882 inside the offline container; POST `/v1/responses` returns:

- e429: HTTP429, `{error:{message:"Too many requests",type:"rate_limit_exceeded",code:"rate_limit_exceeded"}}`.
- insufficient: HTTP429, `{error:{message:"You exceeded your current quota",type:"insufficient_quota",code:"insufficient_quota"}}`.
- ok: existing text SSE, assistant `ok`.

No API key is configured. The custom Responses provider has `requires_openai_auth=false`, `request_max_retries=1`,
`stream_max_retries=1`; both HOME and CODEX_HOME are scratch. `tui.status_line=["context-remaining"]` matches the
item AgEnD adds. Launch flags: `--dangerously-bypass-approvals-and-sandbox --no-alt-screen`. This is the actual
production approval flag; isolation is provided by the disposable network-disabled container, not a host sandbox.

| Fixture | Sequence |
|---|---|
| exhausted429 | paste `please reply to this audit request`, separate Enter, mock e429; wait until exhausted row and idle composer |
| repeated429 | another user submission `please try again`, same mock failure; second exhausted row |
| recovered | change mock to ok; paste the existing conditional continuation text; a new successful turn preserves old request history |
| insufficient-quota | next user turn, mock insufficient; real rendered quota sentence, with older429 rows still above it |

A separate quiet-window run observed no further HTTP requests for20seconds after the exhausted row, then submitted a
conditional continuation with the mock recovered. The outgoing main-thread request still contained the original user
request and produced `• ok`. This proves retained context and the absence of automatic retry during that measured
window; it is not a model-completion or real quota/account test.

[repro-429.py](../../../scripts/manual/codex-version-audit/repro-429.py) contains the scenario driver. It refuses host
execution and requires a container with only the loopback interface. Before running it, copy the extracted platform
payload to `/opt/codex-audit`, create/chown `/home/rh/cx/{home,code,work}`, start the mock with
`PORT=18882 MOCK_MODE_FILE=/home/rh/cx/mode MOCK_LOG=/home/rh/cx/mock.log BODY_LOG=/home/rh/cx/requests.jsonl`,
and set `AGEND_CODEX_429_REPRO=private-container`. The driver never invokes AgEnD or a shared tmux server.
