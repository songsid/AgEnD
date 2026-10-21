---
section: Added
---
- **Web Settings: search every setting (#2347).**
  - **Search settings** sits on top of the sections; **/** focuses it.
  - It finds a setting by its name, its `fleet.yaml` key or the words people use, in either language: "token" finds the Cloudflare token, bot tokens and provider API keys; "語言" finds the dashboard and bot reply languages; "port" finds the fixed address.
  - Results are grouped by section. **Enter** or a click goes there, focuses the field and flashes it.
  - The same settings appear under **Settings** in **Ctrl K**.
  - When a field to fix is in another section, the bar names that section and takes you there.
