---
section: Fixed
---
- **A kiro `/compact` from the web chat now says when it ends (#1925).** On kiro's classic UI and the TUI's V2 engine, the card follows the instance's own pane: **Conversation compacted**, or that kiro did not compact the conversation because it was too short or the compaction was stopped. On the TUI, "compacted" means kiro's "Compacting conversation..." line came and went; a failure other than "too short" can't be told apart. kiro's V3 engine still says its compaction end can't be detected.
- **The kiro docs no longer say an instance's agent loads no steering (#1925).** kiro loads `.kiro/steering` for every agent, even one with `resources: []`, so a new conversation also reads the steering files in its directory.
