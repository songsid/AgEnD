# kiro-cli 2.34.0 classic: `/compact` goes on in a new conversation (#2714)

Captured offline on 2026-10-26 from the real kiro-cli 2.34.0, run as `chat --legacy-ui --agent-engine=v1 --model auto --trust-all-tools`.
- Rig: `../kiro-2.34.0-audit/rig/`. It uses an isolated HOME under `unshare -rn` and a private tmux socket. Replies come from `KIRO_MOCK_CHAT_RESPONSE`, and the compaction summary is a mock reply too.
- No account was used, and the host's kiro is untouched.

`conversations_v2.json` holds the store's rows for one working directory after this sequence: `hello one`, `hello two`, `/compact`, `hello three`, `/compact`, `hello four`.
- The rows are verbatim, with two changes: the scratch path is replaced by `/work/kiro-classic`, and the large `tools` and `context_manager` fields are dropped.
- The rows are A `9c2ec2a7…`, then B `b6492827…`, then C `2cf8d31d…`.

What it shows:
- **A new id per compaction.** Each `/compact` writes a new row with a new `conversation_id` and a non-null `latest_summary`. kiro then keeps writing that new row; the old row is never written again.
- **No parent pointer.** Neither row's value mentions the other's id.
- **The link is the transcript.** The new row's `transcript` starts with the old row's whole `transcript`, followed by `> /compact`.
- **The new row is created after the old one's last write.** B's `created_at` is later than A's `updated_at`, and C's is later than B's.
- **`--resume-id <id>` keeps the id.** It writes to the same row, and only `/compact` forks.
- **No transcript cap.** In the same session, a conversation seeded with a 600-entry transcript was resumed by id; its row went to 603 entries, and its compacted successor to 606. Nothing was trimmed, so the prefix holds for long conversations.

These facts match the issue's 2.22.0 report: B has a smaller history, `latest_summary` set, and the same working directory.

The TUI's V2 engine cannot be run offline on this rig: it ignores `KIRO_MOCK_CHAT_RESPONSE` and waits on the network. For V2, the evidence is `../kiro-2.30.0-compact-pane/`, a real-account capture: one session log (`<id>.jsonl`) holds a `Compaction` record for each of four `/compact`s, so the id survives compaction.
