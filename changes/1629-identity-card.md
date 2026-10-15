---
section: Added
---
- **Web: identity cards (#1629).** Each agent can have a portrait, a banner, a tagline and a bio, shown at the top of its Details, in View and folded into its chat.
  - The agent sets its own with `set_web_theme` (`card.*`) and `set_web_theme_asset` (`portrait`, `banner`); a person sets theirs in View's **Edit profile**, and the person's wins field by field. **Clear card** removes the person's; **Reset theme…** removes the agent's.
  - Each card has **S / M / L**; **Settings → Appearance** sets every card's size on all your devices.
  - Upload limits are `web.appearance` in `fleet.yaml` or **Settings → Appearance** (defaults: portrait 1024×1536 / 1.5 MiB, banner 1600×600 / 768 KiB, 8 pictures / 4 MiB per agent), under hard bounds. A higher limit waits for a fleet admin's confirmation, and nothing stored is deleted when a limit changes.
  - Pictures larger than one message go up in parts, from the agent's tool and from `agend-agent theme asset`.
