---
section: Changed
---
- The warning for a `file:` prompt reference found only relative to the fleet directory no longer says the fallback is removed in 2.2 (it is still there); it now says a later release will remove it. The feature guide now separates explicit waking (`wake_instance`, an orchestration tool) from the indirect wake a worker's `send_to_instance` can cause when it delivers to a paused instance.
