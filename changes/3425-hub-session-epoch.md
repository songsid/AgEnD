---
section: Changed
---
- **Hub browser sessions carry a durable directory epoch (#3425).** An older directory response or session cannot regain access after its epoch changes, including after reopening the Hub. This prepares the guarded web setup and AD settings flow; those controls are not exposed by this change.
