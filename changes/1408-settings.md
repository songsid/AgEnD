---
section: Changed
---
- **`/settings` is now part of the app (#1408, step 3).**
  - Settings has the same sidebar, look and themes as the chat; moving between them no longer reloads the page.
  - Agents, Connections, ClassicBot, General and Developer are tabs, each with its own address (`/settings/<section>`). Each agent's and connection's settings open in a dialog (a sheet on a phone), and **New agent** is the sidebar's New instance.
  - Changes are staged and applied together, as before. Once you press **Apply changes** it carries on even if you leave Settings; its progress shows in any panel. Leaving Settings with staged changes asks first.
  - A change that needs a fleet admin's confirmation (#1423) shows a card in any panel, with what it changes, the time left and **Withdraw**. The same goes for a confirmation-gated New instance, delete or Fleet config save.
  - An agent's model that is not known yet now reads "default (detected when it starts)" instead of "default (not probed yet)".
