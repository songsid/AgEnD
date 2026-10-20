---
section: Fixed
---
- **The Windows installer no longer gets stuck updating WSL on a shared office network.** A WSL that is already version 2 or later (read from its own file, without running it) is not updated again: "WSL 2.x.y 已安裝，略過更新" ("WSL 2.x.y is installed, skipping the update"). An older one is still updated through the Microsoft Store first, with GitHub only as a fallback. When an update fails but the WSL there is usable, the installer warns and goes on. When GitHub refuses (it allows each network address 60 requests an hour, so many people behind one address run out) or the network fails, it says so in plain words: try again in about an hour, or on another network.
