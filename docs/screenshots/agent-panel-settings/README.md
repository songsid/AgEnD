# An agent's settings, by category — before and after

Drawn in the real web app, in a headless browser, against two scratch fleets (each with its own `AGEND_HOME`, loopback only, no chat channel): one built from `release/2.3.5-alpha` (9771ccdc7; "Before"), one from this branch ("After"). Both have the same two agents; `claude-kasa` has a description and two tags.

Each image has the two builds side by side, "Before" on the left.

- `agent-{desktop,phone}-{light,dark}-{en,zh-TW}.png` — the 8 cases of the agent page (desktop 1440×900, phone 390×844; light and dark; English and Traditional Chinese). Before: the **Details** tab, read-only, with "Edit in Settings" leading to the Settings page. After: the **Settings** tab on *Basic info* — the same agent's settings in the page, with the category menu on the left (a list on a phone).
- `settings-{wide-1440,mid-1020,narrow-390}-light-en.png`, `settings-wide-1440-dark-zh-TW.png` — the Settings page itself (Settings → Agents), because the menu rules it shares with the agent page (S1–S5) change it too: a hairline under the header, group titles that read as labels, the first-level menu as tabs at the middle width.
