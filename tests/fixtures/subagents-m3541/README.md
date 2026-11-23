# subagents-m3541

Scrubbed from a real Claude Code 2.1.330 session (M-3541, 2026-11-23). Only the fields the subagent and step parsers
read are kept. Every prompt, reply, tool input and notification text is replaced by neutral text, and the cwd is
`/rig/work`.

- `claude-parent.jsonl`: a human turn launches "Describe the user's screenshot" in the background. Its completion
  notification starts the next turn (`origin.kind: "task-notification"`, `producer: "session-task"`,
  `promptSource: "system"`), which launches "Describe second screenshot" in the background.
- Record 2 stands in for the one that hid every run. In the real capture it was a Claude Code `api-request-shape`
  diagnostic of 193,395 characters; here it is synthetic, over the 128,000-character line limit.
- `claude-agent-<id>.jsonl` and `.meta.json`: the two children, scrubbed the same way. Each meta file is its final
  version (`finished: true`).
