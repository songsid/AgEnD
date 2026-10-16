---
section: Changed
---
- **Web chat takes bigger files, and the limits are yours to set (#1937).**
  - **Defaults:** 50 MB per file and 100 MB per message (was 10 MB and 25 MB), still up to 5 files.
  - **Config:** `web.upload_max_file_mb` and `web.upload_max_total_mb` change the two sizes (whole MB, 1–500). `agend reload` applies a change to the next upload.
  - **Public link:** a file is at most 95 MB, the most a Cloudflare quick tunnel carries in one request.
  - **Memory:** uploads stream to disk instead of being held in memory, and large downloads stream too. An upload that stalls for a minute, or runs past 30 minutes, is dropped with its partial file.
