---
section: Fixed
---
- **Show Grok's locally cached models in WSL model selectors.** When AgEnD's catalog is empty, Settings asynchronously reads the model IDs and display metadata already saved by the host's default Grok account. Named, invalid or unresolved Grok profiles never borrow that account's cache; this adds no new profile-home mapping. The source is labelled as the local CLI cache, credential fields are excluded, and opening or refreshing a selector only rereads the file, without starting a CLI or provider request.
