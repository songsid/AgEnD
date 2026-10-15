---
section: Fixed
---
- **macOS: an update run from an agent's session no longer leaves the fleet stopped.** On launchd, `agend restart` and `agend update` stop the fleet and then start it again. Run from an agent's session, the command was killed together with that agent when the fleet stopped, so the second step never ran: the fleet stayed down and no message was shown. Such a command now continues in the background and writes its output to `~/.agend/service-activation.log`. `agend start` also finishes an activation that an interrupted update left pending, so `agend restart` no longer refuses afterwards. (#1871)
