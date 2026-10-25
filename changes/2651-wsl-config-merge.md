---
section: Fixed
---
- The Windows installer now backs up and merges WSL configuration instead of replacing it. Existing memory, swap, network, automount and other unrelated settings are retained; a failed or stale Linux configuration write stops installation.
