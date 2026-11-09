---
section: Fixed
---
- **`agend topic bind` / `unbind` no longer rewrite the whole fleet.yaml (#1490).** Binding a topic used to dump the defaults-expanded config over the file, which dropped comments, expanded absolute paths, and wrote both a legacy `channel:` and a `channels:` list. Those commands now patch only `instances.<name>.topic_id` on the original YAML and keep the rest of the file. A YAML anchor shared with another instance is detached first, so only the named instance's topic changes.
