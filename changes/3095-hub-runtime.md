---
section: Added
---

- Experimental (Hub, off by default): the fleet can now run a set-up Hub. Once `hub.enabled` is on, a Hub sealed by `agend hub init` starts and stops with the fleet and follows configuration changes without a restart. Its records live in a private database with a tamper-evident audit log: question and answer text is encrypted, and only the asked owner or an assigned auditor can read it. Until the Hub's web service and the member side ship, an enabled Hub stays down and records why. While both Hub switches are off, nothing Hub-related loads. (#3095)
