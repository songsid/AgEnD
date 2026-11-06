---
section: Added
---
- **Agents can create projects and move existing main tasks between them.** The `task` tool has two new actions. `create_project` takes a name and a description. `move_project` takes `ids` and `project`, moves each listed main task on its own, and reports a line per card. `update` now also takes `project`: a project's id, or null / `"none"` to take a main task out of its project. A card keeps its ID, status, assignee, comments, history, dependencies and sub tasks, and its sub tasks follow it. An agent can move only a main task it may edit: one that is unassigned, assigned to it, created by it, or dispatched by it. Archived projects are refused. Setting a project's lead, renaming it and archiving it stay with people.
