---
section: Fixed
---
- **kiro classic: a restart no longer goes back to the conversation from before a `/compact` (#2714, reported by hxhsandy).** Classic kiro (`--legacy-ui --agent-engine=v1`) continues a compacted conversation under a new id. AgEnD kept the old id, so the next restart resumed the pre-compaction conversation.
  - AgEnD now follows the compaction to the conversation kiro kept writing, but only on proof that it is this instance's: same directory and store, created after the old one's last write, carrying kiro's compaction summary, its transcript continuing the old one's, and not claimed by another instance.
  - If two conversations both continue the old one, or the store can't be read, AgEnD keeps the recorded id and says why in the Log tab.
  - A freshly started instance that compacted before its first restart is taken up the same way.
  - The TUI's V2 engine keeps its id through a compaction and is unchanged.
- **kiro: a fresh start caused by a lost claim is now explained (#2714).** When the recorded conversation's claim file is missing, incomplete (for example, without its trailing newline), held by another instance, or given up, the launch warning says which conversation was set aside and why.
