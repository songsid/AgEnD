---
section: Fixed
---
- `/login`: if someone pastes the one-time access token from the bot's private message into a chat (a topic, General or the web chat), AgEnD hides it before the message is logged, indexed or handed to the agent. It then cancels that token, sends a new one privately (or shows it in the dashboard's sign-in window) and replies once there to say the token goes into the terminal page, not a chat. Before, the token was written in plain text to daemon.log, the activity log and the search index.
