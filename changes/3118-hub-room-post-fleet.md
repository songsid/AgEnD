---
section: Added
---
- Shared agents on a connected, compatible Fleet can list their Hub rooms and post with `hub_room_list` and
  `hub_room_post`. Each post uses the invoking agent's current room membership; an uncertain result keeps its
  original operation identity rather than silently posting twice.
