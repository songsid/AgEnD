---
section: Added
---
- **Web chat: preview an agent's HTML (#1306).** A ` ```html ` block in an agent's reply gets a card under it:
  **Preview** runs the HTML in a sandboxed frame served by a separate local listener (`web.preview_port`, default
  `health_port + 1`), so it cannot use the dashboard sign-in or act on the dashboard; **Stop** closes it; **Download**
  saves it as `reply.html`. Previews are **off on every device until that device opts in** (sidebar or the card's menu),
  run only on a click, and carry a banner saying they may be able to send data out and can slow or freeze the tab.
  Only replies the fleet marks as an agent's get a card — HTML from people is only ever code. Through a tunnel or
  proxy, previews need `web.preview_origin` (a separate host name); otherwise the card says why they are off.
