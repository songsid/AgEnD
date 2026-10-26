---
section: Fixed
---
- The Windows installer now checks the public sign-in page when verifying dashboard readiness. The old root URL redirected to a protected page and rejected healthy installs on both stable 2.3.1 and beta releases. Service and startup health checks remain required (#2704).
