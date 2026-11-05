---
section: Added
---
- **Hub (experimental, off by default): a member's own exposure store and the owner's publish flow (S3c, #3095).** With `hub_member.enabled`, a member fleet keeps the agents its owner shares in its private Hub database (`hub-member/<hubId>/`), versioned and audited. Sharing or revising one (a data view and read tools picked under the agent in Settings → Connect to a Hub) waits for the owner's Settings confirmation and is published only once restricted execution says it can run there. Withdrawing takes effect at once. The Hub gets the complete current list on every reconnect and after each change. Never over the public link or for a guest; the Hub can never publish on the owner's behalf.
