---
section: Changed
---
- **Compact usage shows when each window resets, and last known numbers as bars (#2447).**
  - Each bar row now ends with its own reset: "5h ███ 92% ↻ 8m" and "7d ███ 56% ↻ 3d". The single reset on the account's name line, the soonest one, used to hide when the week reset. Antigravity's pool lines each get their own reset too. The tooltip keeps the exact times.
  - An account showing last known numbers, such as an expired token, now shows its bars, percentages and resets, muted as on the full card, with a small "cached at 07:47" on its name line; the reason is in its tooltip. An account with no numbers to show keeps its one-line notice.
