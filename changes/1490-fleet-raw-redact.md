---
section: Security
---
- Settings no longer reads a credential written inline in fleet.yaml back out (#1490): `GET /api/settings/fleet` and `/api/settings/fleet/raw` show a hand-written `bot_token` (or any `token`, `secret`, `password`, `api_key`, `web_token` key) as `[configured - redacted]`. A save built from that read carries the placeholder back, and the stored value is kept: connections are matched by id, instances and defaults by path. A placeholder with no stored credential behind it is refused with 400, and fleet.yaml is left untouched.
