---
section: Security
---
- **Web: a guest who signed in through the public link no longer receives the host's sidebar preferences (#1920).** The page and its preference reads gave them the host's sidebar order, favourites, folded groups and per-agent card sizes, which can name agents outside the guest's scope. A guest through the link now gets only what a guest gets anywhere: the host's theme and language, and nothing that names an agent. This affected only fleets with `web.guests.enabled: true` and the public link open.
