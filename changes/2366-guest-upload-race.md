---
section: Security
---
- **Web guests: an upload in flight no longer lands in an agent the guest stopped reaching (#2366).** A guest's upload was checked when it started, then its body streamed. If an admin narrowed or removed the guest's access, or made guests read-only, before it finished, the file was still stored for that agent. The guest's access is now checked again when the upload lands. An upload out of scope is refused and its partial file removed.
