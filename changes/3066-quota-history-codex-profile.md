---
section: Added
---
- **AgEnD now keeps each account's weekly quota over time, and tells Codex usage apart by account.** Groundwork for the measured weekly capacity (#3066).
  - **Weekly history.** Each weekly percent AgEnD reads (on the usage page, from `get_usage`, or on the Discord presence refresh) is kept in `usage-quota-history.jsonl` when it moved. That is a few KB per account a week, kept 12 weeks and never over 2 MB.
  - **Background read.** A fleet without a Discord bot now reads the quota every 30 minutes while an account has a running agent, so its history doesn't depend on someone having the page open. It is the same cached read as before, never a vendor call more often than 5 minutes.
  - **Codex by account.** Each Codex launch now records which credential profile it runs under. Codex usage is then counted per account (per credential profile) instead of "profile not recorded"; usage from before this version stays unrecorded. (#3066)
