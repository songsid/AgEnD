---
section: Changed
---
- **Skill: credential-profiles updated for Claude Code profile usage rows (#1753).** The stale "Claude Code profiles do not have usage rows of their own yet" note is replaced with the correct behaviour: each named Claude Code profile now has its own `Claude (<profile>)` row reading quota from its own login, and a never-signed-in profile shows "Not logged in — run `/login claude-code <profile>` to sign in". The Signed-out reminder row is now documented as Kiro-only.
