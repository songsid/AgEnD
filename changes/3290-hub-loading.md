---
section: Fixed
---
- **Hub pages distinguish loading from empty results (#3290).** Session, chat lists, room history, shared agents, recent activity, Administration and Hub-related settings use the shared grey skeletons while their first read is pending. Failed reads stop loading and offer retry where supported; existing activity remains visible during refresh.
