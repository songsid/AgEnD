---
title: Configuration
description: AgEnD configuration reference
---

## fleet.yaml

The main configuration file lives at `~/.agend/fleet.yaml`.

```yaml
defaults:
  backend: claude-code
  model: sonnet

instances:
  my-project:
    working_directory: ~/projects/my-app
    topic_id: "123456789"
```

## classicBot.yaml

ClassicBot configuration for Discord slash commands.

---

*Full configuration reference coming soon.*
