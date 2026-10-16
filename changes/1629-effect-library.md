---
section: Added
---
- **Effect library foundation (#1629):** adds private, content-addressed Canvas Worker storage, scoped upload/mod claims, quota and reference checks, and transaction rollback receipts. This backend foundation does not expose upload tools or run effects yet.
- The shared atomic file writer completes positive short UTF-8 writes before publication and preserves the old file if writing stalls or fails.
