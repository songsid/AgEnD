---
section: Security
---

- **The web Log tab masks Cookie and Set-Cookie header values (#3077).** Whole headers, including folded continuation lines and structured Cookie fields, are redacted before the step text is cut. Harmless SHA-like hex stays.
