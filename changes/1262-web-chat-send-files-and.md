---
section: Added
---
- **Web chat: send files and images, and see the ones the agent sends back.** The composer has a 📎 button, and
  files can also be pasted or dropped onto the chat (up to 5 per message, 10 MB each, 25 MB together; PNG, JPEG,
  GIF, WebP, PDF and text files). The agent gets them exactly as from Telegram — the file in the instance's
  workspace inbox, a `[📷 Image: …]` / `[📎 File: … → …]` line and `image_path` / `attachment_path` — and files the
  agent attaches to a reply are shown in the web chat (images inline, others as downloads). The type is read from
  the file's bytes, not from its name or the browser's word for it; the stored name is chosen by the fleet; and a
  file can be fetched back only by an id the fleet issued for it (`/ui/file/<id>`), never by a path. Anything that
  is not one of the four image types is served as a download, never rendered. A file attached but not sent within
  30 minutes is deleted, also across a fleet restart: an upload is stored as `web-pending-…` until a message takes
  it, and those left over are swept at startup once 30 minutes old (#1273). Sent files follow the inbox's 7-day
  rotation, like Telegram's.
