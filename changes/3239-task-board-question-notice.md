---
section: Fixed
---
- The task board's notice that an agent has been quiet for an hour on a claimed card is no longer put off when Claude compacts its own context while idle. For Claude and Codex agents, progress now means a tool call or an answer in the agent's own session, not its spinner. And when an agent holding a card ends its turn on a question it sent to no one (the question was only on its own screen), the agent that handed it the card now gets a task-board notice quoting the question.
