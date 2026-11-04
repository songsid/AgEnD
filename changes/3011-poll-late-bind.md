---
section: Fixed
---
- **A short poll no longer stays open when its message was posted late (#3011).** If the chat platform confirmed the poll's message after the poll's own deadline (for example a 20-second poll on a slow Discord send), the poll was not closed until something else happened, and its results did not reach the agent until `close_poll`. Now a poll or a set of reply buttons that is already past its deadline when its message is confirmed is closed or expired at once. The delay between creating the buttons and the platform confirming the message is logged.
