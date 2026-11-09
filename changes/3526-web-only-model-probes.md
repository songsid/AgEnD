---
section: Fixed
---
- Web-only fleets now discover host model catalogs at startup, and adding an Agent or changing its backend/account starts a bounded background probe. Empty probes keep the last good list. Default Antigravity accounts are covered; named Antigravity accounts remain unsupported. Thanks to junsion for the diagnosis (#3526).
