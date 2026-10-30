---
section: Fixed
---
- A Grok instance that hits its weekly limit is no longer left on Grok's "You hit your weekly limit." prompt (Upgrade tier / Buy more credits) with a "parked on a CLI dialog" warning and a Needs-you item. AgEnD now closes the prompt with Shift+x, never choosing an upgrade or credits, and pauses the instance with one notice; the next message or `/wake` resumes it once the limit resets. The "parked on a CLI dialog" warning also no longer ends with Claude's session-resume advice unless the dialog is Claude's resume prompt.
