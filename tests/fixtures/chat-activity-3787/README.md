# chat-activity-3787 fixtures

`codex-0.160.0-web-chat.jsonl` is a real rollout of **Codex 0.160.0** (`codex exec` and two `codex exec resume`, model
`gpt-6.1-sol`, no sandbox) answering three web-chat messages the way an AgEnD instance receives them: each prompt carries the
`[agend-human-id:…]` / `(message_id: … | verification_id: …)` lines AgEnD writes, and the agent answers through an MCP tool named
`reply` on a server named `agend`.

- turn 1: read a file, a command that fails (exit 127, no `python`), a retry, a read of a file that does not exist (exit 1), the reply.
- turn 2: `auto_compact_token_limit` set to 6000, so Codex compacted **four times** — once right after `task_started`, before the
  turn's own prompt is written, and three times in the middle of the turn. The steps before and after each compaction belong to
  the same `turn_id`; the `compacted` record carries no `turn_id` (here a few KB, in a long session megabytes).
- turn 3: a reasoning record. Codex wrote `summary: []` and an encrypted blob: no readable thinking, as in every real rollout
  seen (0.153–0.167: 9,000+ reasoning records, none with a summary).

`codex-0.160.0-web-chat.ledger.json` is the chat ledger `/ui/history` would serve for the same six messages (`anchor`: what AgEnD
records for each row — the user's `message_id`, and the `messageId` the `reply` call returned).

## What is real and what is not

Real: the Codex record types, their order and fields, the model's tool calls, commands, outputs, exit codes and durations, the
turn ids' shape, the compaction records.

Not real: the `agend` MCP server was a tiny stub that answers `reply` with `{"chatId":"web","messageId":"web-stub…"}` (the
shape AgEnD's own returns). The stub restarted with each run, so a later run reused the first one's id; the redactor renames the
repeats (`…-t2`, `…-t3`) because AgEnD's ids are unique. The prompts are written for the test (a file `notes.txt`), not a person's.

## Redaction

`scripts/manual/codex-activity-fixture/redact.mjs` made this file from the raw rollout, and refuses to write if its own check
finds anything left. Kept: only the records the activity parser reads (plus `turn_context`, trimmed). Removed: the account and
user ids of `session_meta`, developer messages, token counts, world state, thread settings, the installed-tools listing that
`ALL_TOOLS` printed (it names the person's own connectors). Replaced: the working directory and OS user name
(`/home/user/project`, `user`), the time zone (`UTC`), the encrypted reasoning blob (a fixed placeholder), every opaque id (turn,
thread, call, message, response, process) by a numbered one, and the `compacted` record's replacement history (a stub).

The check also refuses a one-time, verification or authorization code — on either side of its label (`code: 123456`, `123456 is your
code`) — an OAuth code (a callback URL's `code=` / `state=`, a provider's `4/0A…` style, a `code` / token field) and the key, token,
email and path shapes above. A refusal says the category and where the record is (its line in the rollout), never the value; a line
that is not JSON is refused the same way. `tests/codex-activity-fixture-redact-3787.test.ts` runs the script on invented values.

Checked with grep before commit (independently of the redactor's own check): no home directory but `/home/user`, no user name, no token / key / JWT / bearer / email shape, no
one-time code, no connector or account name, no host or tailnet name.

## Not captured

No `FileChange`, `Extension` (web search) or `ImageView` item occurs in this capture; those are shaped from real items of Codex
0.159–0.167 rollouts (field names only, no content) in `tests/chat-activity-codex-3787.test.ts`. A reasoning *summary* never
occurs in a real rollout; the test that shows one builds it from the record shape.
