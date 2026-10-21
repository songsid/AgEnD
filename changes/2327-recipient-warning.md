---
section: Fixed
---
- **A cross-instance message's warning no longer calls one detected error a pause after repeated errors (#2327).** `send_to_instance` warned "is paused after repeated errors" whenever the recipient had matched a single error pattern — even a notify-only line on an instance that was still running and not paused. The warning now names what was actually seen (an error, quota, provider-limit or authentication message) and that the instance is waiting to recover; it says "paused" only when the recipient is paused, and a CLI that is no longer supervised is reported as not running.
