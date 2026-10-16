---
section: Added
---
- **Effects isolation groundwork (#1629):** the local preview listener now has a separate `/effect` shim with the existing sandbox and network restrictions. It accepts one Canvas Worker render with a private MessagePort; effect code gets an OffscreenCanvas, content-free events and one ready signal, with no document realm. This does not enable effects in the dashboard; the public-link preview remains `/frame` only.
