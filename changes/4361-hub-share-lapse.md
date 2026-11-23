---
section: Changed
---
- **When a shared agent's backend or folder changes, its Hub share now says it needs sharing again.** As before, the earlier share does not carry over to the new backend or folder. Now:
  - **Needs you** shows an item, which goes away once the agent is shared again.
  - The `/backend` answer says the agent needs sharing again.
  - The agent's Hub tools answer `share_needs_reshare` instead of a bare "unavailable".
  - Settings → Hub and the Hub's My shared agents show **Needs re-share** with **Share again**. Sharing again from either page keeps the people who may ask the agent (active grants, same expiry). Stopping and sharing again still removes them.
