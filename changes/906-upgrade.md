---
section: Upgrade Notes
---
- **Kiro: a one-time switch per instance after upgrading (#906).**
  - A conversation from before this version comes back as the kiro agent it was saved under.
  - On its first resume, AgEnD types `/agent swap <agent>` into the instance's pane and confirms it on screen, before
    delivering anything. Only then does it remove that instance's old entries from the shared `.kiro` files.
  - If the switch cannot be confirmed within 15 seconds, the old setup stays, a notice says so, and the next start
    tries again.
  - Two existing kiro instances in one directory both point at the directory's newest conversation: the first to
    start keeps it, the other starts a new one.
  - An instructions file from before this version (`.kiro/steering/agend-<instance>.md`, no fleet tag) is kept,
    because AgEnD cannot tell which fleet wrote it. Delete it by hand once every fleet using that directory has
    upgraded.
