---
section: Added
---

- Experimental (Hub, off by default): a fleet can now be a Hub member. With `hub_member.enabled` on, the owner's "Connect to a Hub" page pairs the fleet. Once paired, the fleet connects to its Hub, rebuilds its state after every reconnect, and keeps the agents it chooses to share in a private, audited store. Exposed agents answer only through an isolated provider that the owner explicitly configures, and only from owner-approved data views. Until data views can be approved, nothing can be shared yet; the page says so. Hub-related problems show in Needs you with the reason. (#3095)
