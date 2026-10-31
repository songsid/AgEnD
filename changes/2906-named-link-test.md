---
section: Added
---
- Settings → Access & security → Public link: a **Test connection** button for your own domain (a named tunnel). It tests the domain, port and token as filled in, saved or not, in five steps: the values, this machine's port, the tunnel connecting to Cloudflare, DNS, and the domain reaching this AgEnD. Each step shows ✓ or ✗, and every ✗ says what to do next. The token is never shown, and the test never disturbs an open link.
- `/web` with your own domain now tells "the tunnel could not connect to Cloudflare" apart from "the tunnel is connected, but this machine can't open its own address". The second happens when this machine's network blocks the domain or its DNS; the link may still work from another network, such as a phone on mobile data.
