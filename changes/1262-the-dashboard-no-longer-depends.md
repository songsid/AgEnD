---
section: Security
---
- **The dashboard no longer depends on Server-Sent Events.** If the live stream says nothing for 15 seconds, or
  keeps failing, the page fetches the same status and chat messages every 5 seconds (`GET /ui/poll`) and goes back
  to the stream when it speaks again. Polling uses the very same `<boot>-<id>` cursor as the stream, so the two can
  take turns without a message twice or a gap, also across a fleet restart. (Cloudflare Quick Tunnels do not carry
  SSE, and a buffering proxy looks exactly like a server that never sends.)
