---
section: Fixed
---
- A Claude account managed in AgEnD starts again when its organization pushes settings that do not affect signing in (`channelsEnabled`). Before, every start after the first was refused with "credential unavailable or source changed". Settings that could change how Claude signs in are still refused, and the message now names them. (#4380)
