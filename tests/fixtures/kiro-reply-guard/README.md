# Kiro human reply completion fixtures

Captured from the real `kiro-cli 2.27.1` on 2026-10-04 in a private 120×45 tmux
pane. A disposable agent had no tools or MCP servers, and `includeMcpJson: false`.
No real auth/config was edited. Launches explicitly pinned:

- legacy: `chat --legacy-ui --agent-engine=v1`
- TUI: `chat --tui --agent-engine=v2`

Both turns printed a requested `SENTINEL_KIRO_*` marker and returned to their
native prompt without an outward tool call. Fixtures keep the current turn's
capture tail; startup banners and older turns are omitted. The TUI cwd and git
branch labels are normalized to `~/kiro-reply-repro` and `(repro)`.

TUI keeps `◔ 1%` visible while generating. Its live bottom composer reads
`› Kiro is working · 0s · Type to steer · Ctrl+S to queue`; this must veto idle
even if output stops. After completion it becomes
`› ask a question or describe a task ↵`. Legacy uses the braille spinner, then
its agent-prefixed percentage prompt.

These fixtures do not establish Kiro v3 completion; v3 stays opted out.
