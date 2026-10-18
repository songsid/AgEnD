---
section: Added
---
- **Fleet → Usage on the dashboard (#2122, part 2).** `/ui/fleet/usage` shows each agent's tokens, requests, delivered messages and their **API-equivalent at list price — not money spent**, ranked, over today, 7 days, this month, all or custom days in the fleet's timezone; grouped by agent, backend, model, credential profile or team (teams as configured now). The ◔ usage dialog links to it (**By agent →**).
  - Every mark is in words: Codex's cache writes "not reported" (never 0), a model "not priced", hours read before the backend and profile were recorded. Kiro and the other CLIs AgEnD can't read are listed with the reason, never as $0. Claude subagent (sidechain) turns aren't counted yet.
  - A daily trend of the top 5 agents and the others, a calendar heatmap that tells a day read with nothing used from a day not collected, and **Download CSV** of the shown answer's daily rows with the basis on each.
  - Signed-in sessions see it; guests never. Over the temporary public link it says "Not offered over the public link", with a link to the new **Settings → Web → Usage report over the public link** switch on the dashboard reached directly (`web.usage_report_on_public_link`; it applies at once).
  - Honest about what it holds: a long range with too many daily rows says from which date the charts and the CSV start; a day used only by an unpriced model reads as used, not priced; after a timezone change each day keeps its own zone, said on the page.
