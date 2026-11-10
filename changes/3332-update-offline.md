---
section: Fixed
---
- **An update with no network now gives up in about a minute, and says why (#3332).** `/update` in chat, the web **Update now** button and `agend update` used to stay at "downloading" for many minutes when the network was down or the registry stopped answering, while npm kept retrying. Now the update first checks that the registry answers. npm gives up on a connection that sends nothing for 30 seconds and tries once more. The failure says **Could not reach the update source**; nothing is changed and the current version keeps running. A slow network that keeps delivering still finishes. Your own npm settings (`.npmrc` or `npm_config_*`) for these timeouts are kept.
