---
section: Fixed
---
- **Stale command confirmations (#1148/#754):** `/clear` rechecks current authority, source/target and the exact daemon/IPC generation after platform retirement waits, before sending the destructive command. Model/effort menus also reject a source channel moved to another target within the same bot. F/C roles stay unchanged; clear remains excluded from web prompts.
