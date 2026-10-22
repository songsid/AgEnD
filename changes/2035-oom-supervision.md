---
section: Fixed
---
- **Stop repeatedly resuming an OOM-killed Claude Code session (#2035).** After two confirmed Linux kernel OOM kills of the observed primary CLI in the same session, stop automatic recovery and tell the operator to free memory and explicitly retry or start fresh. Keep the original session and transcript. Uncertain evidence follows the existing crash policy. Install, start and restart also report systemd’s loaded OOM policy (#2015).
