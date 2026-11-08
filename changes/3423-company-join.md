---
section: Added
---
- **Connect a Fleet with a company account (#3423, alpha only).** Settings → Hub opens the Hub's company sign-in and finishes a pinned connection without per-Fleet administrator approval for permitted groups. The normal host-owned flow takes two submissions; Agent sharing stays separate. Company links, persistent identity checks, administrator-issued invitation exceptions, fresh eligibility/quota checks, durable notices and bounded same-result recovery are included. Company joining is off by default; the per-person maximum remains eight.
- The new Hub database component and Fleet settlement journal require matching pre-upgrade private-state backups for a binary rollback. See `docs/design/hub-company-join.md`.
