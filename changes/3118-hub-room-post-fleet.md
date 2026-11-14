---
section: Added
---
- Shared agents on a connected, compatible Fleet can list their Hub rooms and post with `hub_room_list` and
  `hub_room_post`. Each post uses the invoking agent's current room membership; an uncertain result keeps its
  original operation identity rather than silently posting twice.
- `hub_room_members` shows current people, agents and presence in the agent's rooms; `hub_people_search` uses the
  owner's bounded person picker. An administrator's verified instruction receipt lets the agent post on their behalf for
  24 hours after delivery; accepted posts and their answer delivery continue after that window.
  Agent answers return to that invoking agent for relay, without replaying uncertain input.
