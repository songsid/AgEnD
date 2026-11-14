---
section: Fixed
---
- **On Windows panes, a message sent to a busy agent gets ✅ when the agent actually takes it (#3030 for native and remote panes).** Before, a message queued in a busy Claude Code or Codex agent on a native Windows or remote pane was marked ✅ as soon as it was queued. Now, as on Linux and macOS, AgEnD keeps it on record until the agent's transcript shows it was taken, and marks it ❌ (telling you once) if the agent goes idle without taking it. After AgEnD restarts, a message still waiting in the same agent is watched again; one whose agent is gone and cannot be checked is marked ❌ rather than sent again, since that agent may still have it: a duplicate message is worse than a ❌ you can resend.
