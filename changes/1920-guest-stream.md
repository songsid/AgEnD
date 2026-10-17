---
section: Security
---
- **Web: the dashboard's live stream, its poll and its files now answer each guest for themselves (#1920), with nothing changed for admins.**
  - **Stream and poll:** a guest gets only its own agents' status (who they are, how they look, working or idle) and their activity. It never gets the fleet's details, prompts, Needs you, the Log, traffic, or chat messages; chat comes later, with only what reached the channel.
  - **Files:** a file opens only if it belongs to one of the guest's agents; another agent's file id is "no such file".
  - No guest can sign in yet.
