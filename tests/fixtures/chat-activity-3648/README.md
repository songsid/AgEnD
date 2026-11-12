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
