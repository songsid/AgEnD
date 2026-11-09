---
section: Added
---

- Add protected CA inspection and pinned CA-fetch endpoints for Hub-admin and local host-session AD settings. They reuse the existing directory pool, bind probes to the exact session/source, keep secrets write-only and retain physical slots through TLS close. The AD editor form follows separately.
