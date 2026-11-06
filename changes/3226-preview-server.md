---
section: Added
---
- **Hub (experimental, alpha): an isolated HTML preview listener.** An initialized Hub can set `hub.web.preview_port` to serve the existing fleet preview sandbox over a separate HTTPS port, sharing the Hub browser certificate and its renewal. It is off when unset. HTML stays behind the room's signed-in file permissions; the preview listener serves only an empty bootstrap and never reads or sets cookies. The Hub preview panel follows separately. See [configuration and security boundaries](docs/design/hub-preview.md).
