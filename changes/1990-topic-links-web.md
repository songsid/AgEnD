---
section: Added
---
- **Web: a name in a cross-instance status line or a prompt opens that instance (#1990).**
  - In a chat's status lines ("alice → bob: …"), the other instance's name opens its chat.
  - In a prompt card (a stopped instance, an instance waiting for input), the instance's name opens its terminal View.
  - Both open in the app itself, with no reload or new tab. The links survive a reload and a fleet restart.
  - An agent's or a person's message never gets such a link.
