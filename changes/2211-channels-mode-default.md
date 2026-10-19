---
section: Fixed
---
- A Settings change to one connection no longer asks the admins of every connection to confirm it when fleet.yaml leaves `mode:` (or `id:`) to its default (#2211). Before, each connection showed `mode: topic → absent` in the held change. A connection is now judged and kept as a load gives it, so only a real change counts.
