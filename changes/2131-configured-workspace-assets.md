---
section: Fixed
---
- Allow web-appearance assets and effect packages from an instance's exclusively configured workspace under `workspaces/`, including folders whose name differs from the instance. Other instances' configured and standard workspaces (including stopped or paused ClassicBot peers), shared or overlapping directories, symlinks, hard-linked state files and sensitive files remain refused; General-style state directories still require staging.
