# Codex code-mode tool calls (M-3219)

`code-mode.rollout.jsonl` holds real `response_item` / `custom_tool_call` (`name: "exec"`) records from Codex rollouts on the
AgEnD dev host (November 2026). Codex 0.153+ runs every tool as a JS script driving `tools.*`, so these are what the channel's
tool trace is labelled from.

| Line | What it calls | Codex |
| --- | --- | --- |
| 1 | `exec_single` | 0.169.0 |
| 2 | `exec_computed` | 0.169.0 |
| 3 | `write_stdin` | 0.160.0 |
| 4 | `apply_patch` | 0.169.0 |
| 5 | `view_image` | 0.169.0 |
| 6 | `mcp_other` | 0.160.0 |
| 7 | `web_run` | 0.160.0 |

0.169.0 is the current version. Where no 0.169.0 rollout on the host used a tool (`write_stdin`, an MCP server other than
AgEnD's, `web__run`), the record is from 0.160.0, whose code-mode record shape is the same. No rollout on the host calls
`tools.update_plan` from a script; the tests use a constructed call for it.

Sanitized: worktree and project paths are `/work/repo`, the GitHub repository is `example/repo` and the run id is generic;
the apply_patch body is cut (its `*** Begin Patch` / `*** … File:` / `*** End Patch` lines are kept). The `ordinal` field is
dropped. Everything else (ids, call ids, timestamps, the scripts' text) is as written by Codex.
