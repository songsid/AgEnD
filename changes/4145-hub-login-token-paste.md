---
section: Fixed
---
- `/login`: a one-time access token pasted into a Hub room or a 1:1 Hub question is now handled the same way as in a chat. It is hidden from the agent, cancelled and replaced with a new one sent privately, and the chat where the sign-in started is told. The Hub keeps its own encrypted copy of the post until its retention deletes it, and AgEnD can't remove it there, but the token in that copy no longer works.
