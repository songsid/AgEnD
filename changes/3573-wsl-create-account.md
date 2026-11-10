---
section: Added
---
- **New agent on this AgEnD host can choose its account (AGEND-132).** Choosing WSL / Linux in New agent now shows an **Account** field under the CLI, the same as for a connected Windows computer, for every CLI that has named accounts. It lists this host's accounts (one that isn't signed in can't be chosen), "Fleet default" stays the empty choice, and the choice clears when you change the CLI. The server checks the account before creating anything — it must exist on this host, belong to that CLI and be signed in — and says which check failed instead of falling back to the default. The new agent starts under that account from its first start, with no restart afterwards.
