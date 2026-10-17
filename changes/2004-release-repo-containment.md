---
section: Fixed
---
- **`checkout_repo` works again (#2004), and `release_repo` removes only the instance's own checkouts.** Since the April argument-hardening change, `checkout_repo` failed for every branch ("Needed a single revision"). `release_repo` now resolves the path and removes it only when it is a git worktree inside the instance's own `repos/` directory; anything else is refused and left untouched.
