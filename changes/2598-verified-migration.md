---
section: Fixed
---
- A confirmed classic-to-TUI Kiro migration now checks idle/version/model, carries once, archives the frozen duplicate, and verifies a plain restart with the same conversation/model and V2 readers. Deliveries wait during the workflow; failures stop and error-pause the instance and report in General and its topic. The confirmation warns about sudo/password handling (#2598).
