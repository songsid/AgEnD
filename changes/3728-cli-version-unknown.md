---
section: Fixed
---
- **Grok's card shows its installed version in a container, and Antigravity's no longer says "? is installed".** Where the host cannot make a network namespace (a Docker container; Ubuntu 23.10+/24.04 under AppArmor), AgEnD does not start a CLI to ask its version, so Grok's version stayed unknown. AgEnD now reads it from the `.metadata_version` file Grok keeps beside its download (only when that file is at least as new as the binary). Nothing is started. When a version still cannot be read — Antigravity keeps none on disk — the card says "The installed version could not be read" instead of "? is installed".
