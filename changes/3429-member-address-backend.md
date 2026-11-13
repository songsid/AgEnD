---
section: Added
---
- Hub (experimental): a Hub's member address (where Fleets connect) can change safely. The Hub keeps its identity and keys. Fleets online at the change follow an issuer-signed relocation and keep their connection; the rest lose their credential, their owners get a notice, and their **Reconnect** accepts the moved Hub only on its issuer-signed descriptor. Interrupted changes recover through the shared sealed-settings writer.
