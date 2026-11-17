# Claude Code 2.1.326: a background child launched without a type, notified while the parent is busy (M-3270)

These records come from one real run of Claude Code 2.1.326, in the recording agent's own session: one `Agent` call without a `subagent_type`, run in the background. The child ran two short `sleep` commands, the second of them in the background, so it stopped twice before it finished. The parent was busy the whole time, so each of the child's three notifications was:
- queued at once (a `queue-operation` `enqueue` record), and
- taken into the running turn later (an `attachment` of type `queued_command`, `commandMode: "task-notification"`).

The second and third notifications carry no `<tool-use-id>`.

`claude-parent.jsonl` holds:
- the turn's start;
- the `Agent` call and its async-launch result;
- the three enqueue records;
- the three queued attachments.

`claude-agent-<id>.jsonl` keeps every record of the child, and `.meta.json` keeps its meta.

How the records were cleaned:
- Owned paths are replaced with `/rig/…`.
- Message texts, tool inputs and outputs, the child's attachment payloads and API payloads are replaced or omitted.
- Identity fields, field presence, record order and timestamps are kept.

`manifest.json` binds the original child file's size and SHA-256 hash. The original child was 372 KB. A real child passes 512 KB within minutes; the service test grows the attachment rows back to that size.
