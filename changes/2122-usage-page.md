---
section: Added
---
- **Fleet → Usage on the dashboard (#2122, part 2).** `/ui/fleet/usage` shows each agent's tokens, requests, delivered messages and their **API-equivalent at list price — not money spent**, ranked, over today, 7 days, this month, all or custom days in the fleet's timezone; grouped by agent, backend, model, credential profile or team (teams as configured now). The ◔ usage dialog links to it (**By agent →**).
  - Every mark is in words: Codex's cache writes "not reported" (never 0), a model "not priced", hours read before the backend and profile were recorded. Kiro and the other CLIs AgEnD can't read are listed with the reason, never as $0. Claude subagent (sidechain) turns aren't counted yet.
  - A daily trend of the top 5 agents and the others, a calendar heatmap that tells a day read with nothing used from a day not collected, and **Download CSV** of the shown answer's daily rows with the basis on each.
  - Signed-in sessions see it; guests never. Over the temporary public link it says "Not offered over the public link" unless `web.usage_report_on_public_link: true`.
