---
section: Changed
---
- **Web: a guest's web app shows only what a guest can use (#1920).**
  - **What a guest sees:** the sidebar lists only their own agents, with a "Guest · <name> (<platform>)" chip and their session. There's no Fleet, Needs you, View, Settings, New agent, filters, reordering or bottom tabs. A chat has no View, Log or Details tabs and no ⋯ menu, and its composer has no command list.
  - **Commands:** if a guest types a `/` command, the page says guests can't run commands, and their text stays in the composer to edit.
  - **A note under the composer** (on phones too) says the agent sees their messages as a guest's, which is recognition only.
  - **Behind the scenes:** the page no longer asks for anything a guest would be refused, such as usage, effects, owner CSS or saving preferences. Theme and language stay as the host set them.
