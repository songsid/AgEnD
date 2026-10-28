---
section: Fixed
---
- When a Claude Code agent hits a model's own usage limit ("You've reached your Fable limit."), AgEnD now says so once instead of failing silently every turn. A line in the agent's topic and one Needs-you item name the model and say the reset time is unknown. While the limit holds, the agent gets no "reply-required" recovery turns. The first turn that works again (the limit cleared, or the model was switched with /model) ends the hold, and the Needs-you item goes away. Only Claude's own record of the failed call counts; text on the screen (an agent quoting it, command output) does not.
