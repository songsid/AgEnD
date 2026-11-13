---
section: Fixed
---
- **Pull requests with more than 30 commits now get a complete secret scan (#3745).** CI scans every commit from the merge base to the exact PR head with pinned Gitleaks 8.24.3 and the existing configuration and fingerprint ignores. Unknown, shallow or ambiguous history fails the check instead of scanning only part of the PR.
