---
section: Added
---
- **Team decisions (#3420).** `post_decision` takes `scope: "team"`. A team decision reaches every member of that team (fleet.yaml `teams`), wherever each member works: a teammate in another directory, a worktree or a workspace sees it too. Other teams don't.
  - It is the default for an agent in a team. An agent in several teams names one with `team`. An agent in no team keeps `project` (this exact directory) as the default.
  - Membership is read when decisions are listed and at each launch, so joining or leaving a team takes effect without posting again.
  - An agent's Active Decisions are now the fleet ones, its teams' ones and its own directory's ones.
  - Fleet scope is for rules every team on the fleet follows. The tool description and the delegation and concepts guides no longer suggest it for team conventions.
  - Going back to an older version hides team decisions; it does not show them to everyone.
