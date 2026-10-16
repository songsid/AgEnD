---
section: Added
---
- **Node compatibility checks (#1441).** Without a supported bundled runtime, preinstall refuses an incompatible system Node. Bundled-runtime platforms can install while npm itself runs on an older Node. Skipping lifecycle scripts does not make an incompatible runtime safe: the launcher must find the private runtime or an explicitly allowed, qualifying system fallback. An old updater that already unlinked AgEnD can still leave no installed command if installation fails; see the 2.2 upgrade guide.
