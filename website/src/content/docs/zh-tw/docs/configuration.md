---
title: 設定
description: AgEnD 設定參考
---

## fleet.yaml

主要設定檔位於 `~/.agend/fleet.yaml`。

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

ClassicBot 設定，用於 Discord slash commands。

---

*完整設定參考即將推出。*
