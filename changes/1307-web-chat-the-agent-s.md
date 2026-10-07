---
section: Added
---
- **Web chat: the agent's turn, and attachments (#1307, turn-status part).** The working line counts how long the agent
  has worked (from when the page saw it start), reads "Stopping…" after Stop until the agent is idle, and says when it is
  waiting on its terminal (a permission question, a login, a dialog) — with a "needs you" badge in the sidebar, labelled
  as read from the terminal. Dragging files over the chat shows where they go; each waits as a chip with its name and
  size; a paste over 10,000 characters is attached as a text file (it can go back in as text). On a fleet with no chat
  platform, the hang, clean-exit and interactive-prompt prompts are now asked on the dashboard (they were not asked
  anywhere); an interactive prompt only when there is a General to help.
