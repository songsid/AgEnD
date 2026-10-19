---
section: Added
---
- **Web: an agent's theme can colour the whole page (#2196).** While an agent's chat, View, Log or Details is open, its theme can colour the sidebar, the header and the usage rail too; on a phone, the drawer, the header and the bottom tabs. Open another agent and the page takes its look; open one without page colours and the page is in your own look again. Switching is instant, with no flash and nothing moving.
  - **The agent turns it on** with `set_web_theme {"set": {"page": {"on": true}}}`, optionally with its own sidebar colour per mode (`page.sidebar.light` / `dark`).
  - **You decide per agent:** ⋯ → **Page colours**: the agent's choice (the default), on the whole page, or only its chat. General can set the same for you with `set_web_settings` (`page_colours`). Agents' themes off and `?safe=1` turn it off too.
  - **Colours only.** No fonts, pictures, CSS or layout. AgEnD's status colours (the Needs you count, the state dots, errors, the focus ring) never change, and a page theme is refused unless text, its accent and those colours stay readable on its sidebar and background.
  - **For your own custom CSS (#2199):** while an agent's chat, View, Log or Details is open, `<body>` carries `data-agent="<its instance name>"`, so your stylesheet can follow the agent you are looking at (`body[data-agent="atlas"] { … }`).
  - **The header follows the page.** Before, a chat's header already took the agent's chat colours, though the docs said it never did. Now it is in your own look unless the page colours are on.
