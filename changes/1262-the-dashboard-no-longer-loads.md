---
section: Security
---
- **The dashboard no longer loads its fonts from Google, and every panel carries a Content-Security-Policy**
  keeping scripts, styles, images, fonts and connections to this origin (`connect-src 'self'`), so script that
  somehow ran on a page could not send what it read to another server.
