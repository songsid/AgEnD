# agy 1.3.6: which instruction files it loads, and `/compact` (board 0340ec89)

Captured 2026-10-16 from the real Antigravity CLI 1.3.6 on Linux (ext4, case-sensitive), in a private tmux server,
in a scratch git workspace (no fleet, no live instance). The account line and paths are redacted.

The workspace held five files, each with its own marker line:

| File | Marker | Listed by agy |
|---|---|---|
| `AGENTS.md` | `AGY-ROOT-AGENTS` | yes |
| `GEMINI.md` | `AGY-GEMINI-MD` | yes |
| `.agents/AGENTS.md` | `AGY-UPPER-AGENTS` | yes |
| `.agents/agents.md` (what AgEnD wrote before) | `AGY-MARKER-5T1` | **no** |
| `.agents/rules/agend.md` | `AGY-RULES-DIR` | no |

`instructions-and-compact.pane.txt`: a fresh conversation, two one-word turns, then `/compact`
("Conversation compacted · 5 steps summarized"), then "List every line … that begins with AGY- … Do not read any files and
do not run tools". agy lists the three loaded markers, after its own compaction: what it loads survives `/compact`.
The lowercase `.agents/agents.md` was present the whole time and is not listed. On macOS's default case-insensitive
APFS the two names are one file.
