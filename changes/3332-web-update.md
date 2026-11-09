---
section: Added
---
- **Update AgEnD from the web (#3332).** A fleet admin signed in to the dashboard can now update AgEnD without a terminal or chat:
  - A line at the top of every page says a newer version is out on the install's own line (stable, preview or alpha), with **Update now** and **Later**.
  - **Update now** asks once, then runs the same update as `/update` in chat. Every open tab shows the step and the time elapsed; closing the page does not stop it.
  - A failure says what went wrong in plain words and that nothing was changed; **See the full log** shows the updater's own output.
  - After the restart, a tab still showing the old version offers **Reload**.
  - Settings → Advanced has a **Version and update** card with **Check for updates**, and searching Settings for "update" finds it. An alpha install told about a newer stable release sees it there, with no update button: updating from the web stays on the install's line.
  - Typing `/update` in a web chat opens the same dialog instead of sending it to the agent.
