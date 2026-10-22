---
section: Fixed
---
- **First-run setup works with Ubuntu's umask 0002 (#2435).** AgEnD creates its home privately and safely tightens an existing owned writable home; foreign-owned and symlinked homes remain refused. The shell and Windows/WSL installers prepare the same boundary for older npm releases.
