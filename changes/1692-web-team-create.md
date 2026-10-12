---
section: Fixed
---
- **Web: creating a team no longer overwrites an existing one, or saves members that don't exist (#1692).** The dashboard's **New team** wrote the team directly to fleet.yaml. It saved any member names it was given, and it silently replaced an existing team of the same name, losing that team's members and description. It now goes through the same path as the agents' `create_team`:
  - the members must be instances of this fleet;
  - an existing team is refused ("Team already exists") and left as it was;
  - names such as `constructor` are refused.

  If saving fleet.yaml fails, no team is created.
