---
section: Fixed
---
- Stabilized the outside-connections HTTP tests by sharing a fixed authenticator clock between the fixture and its generated codes. A real request crossing a TOTP step no longer ages the test's previous-step enrollment code out of the valid window; runtime acceptance and replay rules are unchanged.
