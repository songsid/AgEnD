---
section: Added
---
- **Web chat → fleet topic echo (#1320 part A).** Successful web sends are copied to the owning Telegram or Discord topic, with a five-second total ordering budget before replies proceed. On timeout queued copies are dropped; an already in-flight copy may arrive late, with its outcome logged. `web.echo_to_channel` defaults to true and is editable in Settings without persisting untouched defaults. Echo failures do not block web delivery. Visible mention/command labels and a fleet-bot-author/prefix ingress check prevent echoes from starting another turn, including sibling bots and replays; bot-prefix candidates are quarantined while any configured same-platform bot identity is unknown, without affecting humans. ClassicBot and web-only fleets are excluded.
