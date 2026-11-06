---
section: Added
---
- **A web-only fleet has Notices: what General would have said (#2910).** A fleet with no Discord or Telegram connection used to drop these with only a log line. A **Notices** page in the dashboard's sidebar now keeps them:
  - fleet errors;
  - an agent's crash, quota or sign-in notice;
  - web sign-ins;
  - a schedule that could not run;
  - the daily summary;
  - an available update, shown once per version with the `agend update` to run on that computer.
  
  The newest 500 are kept across restarts. New ones arrive live, the sidebar counts the unread ones, and opening the page marks them read. Prompts with buttons stay in **Needs you**. Fleets with a chat connection are unchanged.
