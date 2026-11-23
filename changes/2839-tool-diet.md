---
section: Changed
---
- Agents carry about 4,000 fewer tokens of tool definitions on every turn:
  - The appearance tools (theme, pictures, widgets, ambient effects) are now off by default. Turn them on per agent in Settings → Agents. An agent that has them sees one `web_appearance` tool instead of ten.
  - The emoji and sticker tools are one `emoji_sticker` tool.
  - The task, reply and report_result tools have shorter descriptions, with every field kept. The task board's full rules are in the new `task-board` skill.

  A session resumed with the old tool names can still call them.
