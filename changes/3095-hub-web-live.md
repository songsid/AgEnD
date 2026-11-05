---
section: Added
---

- Experimental (Hub, off by default): a Hub set up with `agend hub init` now actually serves its web pages over HTTPS. Colleagues sign in with the organisation's directory, and the administrator's page works. Every request checks the directory again, so someone disabled there is refused at their next request. When the Hub can't run, Needs you shows "Hub not running" with the reason. Members connecting their fleets come in a later update. (#3095)
