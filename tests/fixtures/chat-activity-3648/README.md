# chat-activity-3648 fixtures

`claude-web-chat.jsonl` is a real Claude Code transcript of an AgEnD instance answering two web-chat messages, trimmed to
the records the timeline reads and redacted: working directory, session and model fields, usage and thinking signatures
are removed; the person's text, the agent's reply text and two tool results are replaced by neutral text. The
anchors (the `[agend-human-id:…]` and `(message_id: … | verification_id: …)` lines of each prompt, the `reply` calls and the
`{"chatId":"web","messageId":"web-…"}` results) are the real ones.

The real thinking blocks of this capture are empty (Claude Code writes the summary text only when
`showThinkingSummaries` is on). The tests that need thinking text add a synthetic summary to a copy of these records.

`claude-web-chat.ledger.json` is the web-chat ledger as `/ui/history` would serve it for the same four messages
(`anchor`: what AgEnD records for each row).

## antigravity and grok (PR2)

`agy-web-chat.jsonl` and `grok-web-chat.jsonl` are real captures of **interactive** AgEnD instances (agy 1.x with
`--continue`, grok 1.x with `--always-approve`) answering two web-chat messages each: a command, a read of a file that does
not exist, a write, a command that fails (exit 1), a middle report and a final one through the `reply` MCP tool.

- agy: `brain/<conversation>/.system_generated/logs/transcript.jsonl`, whole (it already clips its own large fields). One
  planner step holds two tool calls (the first message), and its two results follow as two `GENERIC` records.
- grok: `updates.jsonl` without its `background_tasks` records; each record keeps only `eventId`, `agentTimestampMs` and
  `promptId` of its `_meta`, the `x.ai/tool` meta keeps `name` and `kind`, a tool-schema search result is cut to 500
  characters, the byte-array copy of a command's output is emptied, and a turn's usage is reduced to its total.

Both are redacted: the user name and home directory are replaced by `user`; the instance's working directory is a scratch
directory. The ids (`hmsg-…`, `web-…`), the tool names and the `{"chatId":"web","messageId":"web-…"}` results are the real ones.
`*-web-chat.ledger.json` is the chat ledger `/ui/history` served for the same five messages.

## grok's `events.jsonl`

`grok-events-phases.jsonl` is a real `events.jsonl` of an interactive grok (`grok-4.7`, `--always-approve`) instance on the
preview, two turns: the first complete (`turn_started` … `turn_ended`, with two tool calls), the second still open (reasoning
for five minutes, then a tool call, then reasoning again). grok writes it live — a `phase_changed` the moment a phase starts,
`streaming_reasoning` repeated while it reasons — unlike `updates.jsonl`, which gets a thought only when it ends.

Kept: the lines of the turns, with each long run of identical `streaming_reasoning` lines thinned to three. Removed: the
`mcp_*` records (they name the launch's wrapper script and binding), the session id (zeroed), the tool-call ids (numbered).
The phase values seen are `waiting_for_model`, `streaming_reasoning`, `tool_execution`, `permission_prompt`, `streaming_text`.
