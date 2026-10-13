---
section: Fixed
---
- **The usage panel's plan badge stays on one line (#1749).** In the usage rail and dialog, a long plan such as "TEAM PREMIUM (6.25X)" wrapped onto two lines beside the provider name. It now reads **TEAM ×6.25** (likewise TEAM ×1.25 and MAX ×20). The full plan name shows on hover and is read out by screen readers. When space is tight, the provider name shortens with an ellipsis first, and the ↑↓ buttons stay on the same line. `/usage` and `get_usage` still give the full plan name.
