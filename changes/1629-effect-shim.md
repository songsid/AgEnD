---
section: Added
---
- **Effects isolation groundwork (#1629):** the local preview listener now has a separate `/effect` shim with the existing sandbox and network restrictions. It accepts one HTML render with a private MessagePort and exposes only event subscriptions and a one-time ready signal. This does not enable effects in the dashboard; the public-link preview remains `/frame` only.
