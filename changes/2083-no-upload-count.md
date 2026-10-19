---
section: Changed
---
- **Agents' appearance uploads are no longer counted (#2083).** An agent may upload as many theme pictures, effects (Canvas Worker effects are still beta, 2.3) and proposed mods as it needs. The old limit was 3 an hour.
  - **Still in force:** each picture's size and dimension limits, the agent's picture quota, an effect's and a mod's own size caps, at least 30 seconds between changes and at most 10 changes an hour, the widget-data limits, `web.themes.agent_edit` and a person's lock.
  - **`get_web_theme`:** its `limits` no longer list uploads left.
