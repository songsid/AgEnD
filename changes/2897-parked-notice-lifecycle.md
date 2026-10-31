---
section: Fixed
---
- A "needs a human" notice for an agent held on a CLI dialog no longer piles up. Its topic and General each get one message, which a repeat report edits in place. When the dialog is resolved — closed, answered, or the agent stopped or restarted — AgEnD deletes those messages. Where a message can't be deleted, it's edited to "✓ resolved". A delete that fails is retried, even across a fleet restart.
