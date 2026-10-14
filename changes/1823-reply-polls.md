---
section: Added
---
- **Polls on reply buttons (#1823).** `reply({ buttons, poll: { seconds } })` turns the buttons into a timed, Kahoot-style vote on Discord and Telegram.
  - Everyone who may click there votes once, can change their vote, and is told their own choice privately.
  - While it is open, only "N answered" and the time left show; `reveal: "live"` shows the counts as votes come.
  - At the deadline the buttons show the tally. The agent gets one `[poll results]` message with each option's voters and how many ms after the poll opened each voted, to post the answer and scores itself.
  - The deadline and the results survive a restart, and the results are delivered once.
