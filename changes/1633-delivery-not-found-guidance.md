---
section: Fixed
---
- Correct agent-facing delivery verification advice: “Delivery not found” can mean an ACL-hidden row, expired retention, or no delivery. Agents must obtain an explicitly forwarded verifiable reference before acting, and must not resend uncertain deliveries. Existing instances receive the correction once on reaching 2.2.0; delivery queries and scanner behavior are unchanged.
