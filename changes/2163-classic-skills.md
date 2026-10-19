---
section: Fixed
---
- **A ClassicBot room's agent can read the skills a notice names (#2163).** The 2.3 what's-new notices told every agent to "load the `web-appearance` skill", but AgEnD never gave skills to ClassicBot workspaces. Now:
  - a Classic room's own AgEnD-managed folder gets the skills about its look and the dashboard (`web-appearance`, `persona-emoji`, `web-dashboard`), and none about running the fleet. A folder elsewhere, or a link from that folder to one elsewhere, gets nothing written, and a skill you wrote yourself is never touched.
  - `agend-agent skill <name>` prints any skill AgEnD ships, on any instance (`agend-agent skill` lists them), and a notice that names a skill says so.
  - What's-new items meant for General or coordinators reach only them.
