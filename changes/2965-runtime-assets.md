---
section: Fixed
---
- Windows Runtime builds now write the exact verified asset bytes, refusing source replacements or rewrites during reads. Contributor installs use verified Windows-only node-pty assets without its Linux native build; existing Runtime asset hashes, licenses and archive contents are preserved. Other native dependencies retain their requirements.
