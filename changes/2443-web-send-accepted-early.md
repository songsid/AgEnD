---
section: Fixed
---
- Web chat: a message counts as sent as soon as the agent has it (#2443). If something failed after that, the chat used to say it was not sent, and **Retry send** delivered it again; now it shows as sent, and a Retry still delivers nothing twice.
