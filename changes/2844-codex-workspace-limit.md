---
section: Fixed
---
- A Codex agent in a business workspace that runs out of credits, or hits the owner's spend cap, is no longer left on Codex's "Request increase? / Notify owner?" prompt with a "stuck on a CLI dialog" warning and a Needs-you item. AgEnD now closes the prompt with Escape (it never asks the owner) and pauses the agent with one notice: "Codex workspace credits exhausted — workspace owner must refill", or "Codex workspace spend cap reached — workspace owner must raise it". Queued messages are kept, and the next message or `/wake` resumes the agent after the refill. Waking it does not pause it again on the old error line.
