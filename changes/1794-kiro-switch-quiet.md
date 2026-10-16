---
section: Changed
---
- **Kiro agent-switch notices (#1794, superseded by #1800).** Automatic swapping on resumed conversations is suspended, so no swap or retry is attempted and no failed-switch topic notice is emitted. The saved agent and shared files stay in use. Shared .kiro read/write failures still need attention and remain visible.
