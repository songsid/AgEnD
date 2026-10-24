---
section: Fixed
---
- **Forwarding our bot’s image to another ClassicBot room no longer triggers it (#2576).** Discord forwards are context, not native replies or authored mentions; forwarded images are preserved. Native-reply triggering is now opt-in, off by default: `fleet.yaml` → `defaults.reply_triggers`, overridden by `classicBot.yaml` defaults or per-channel `reply_triggers`. Settings shows the defaults and effective inherited values. Exact mentions still trigger; fleet-topic bot traffic is unchanged.
