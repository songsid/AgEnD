# An agent's settings, by category — before and after

Drawn in the real web app, in a headless browser, against two scratch fleets (each with its own `AGEND_HOME`, loopback only, no chat channel): one built from `release/2.3.5-alpha` (9771ccdc7; "Before"), one from this branch ("After"). Both have the same two agents; `claude-kasa` has a description and two tags.

Each image has the two builds side by side, "Before" on the left.

- `agent-{desktop,phone}-{light,dark}-{en,zh-TW}.png` — the 8 cases of the agent page (desktop 1440×900, phone 390×844; light and dark; English and Traditional Chinese). Before: the **Details** tab, read-only, with "Edit in Settings" leading to the Settings page. After: the **Settings** tab on *Basic info* — the same agent's settings in the page, with the category menu on the left (a list on a phone).
- `settings-{wide-1440,mid-1020,narrow-390}-light-en.png`, `settings-wide-1440-dark-zh-TW.png` — the Settings page itself (Settings → Agents), because the menu rules it shares with the agent page (S1–S5) change it too: a hairline under the header, group titles that read as labels, the first-level menu as tabs at the middle width.

## SKEW (a tab still holding old modules)

`skew-{A,A2,B}-{desktop,phone}.png`: the real app in a headless browser, signed in, on a build of this branch whose served files (`dist/ui/…`, read per request) were swapped for the ones from `release/2.3.5-alpha` @ a5bd6ba55; each image shows the agent page (`?cat=basic`), the chat page and Settings → Agents → the agent's dialog.

- **A** — the base's shell (`shared/instance-nav.js`, `shared/view-strings.js`, `shared/app-i18n.js`) with this branch's panels.
- **A2** — A, and the base's `shared/app.css` too (what an old tab really holds).
- **B** — this branch's shell with the base's panels (`panel-details.js`, `panel-settings.js`, `settings-dialogs.js`, `settings-model.js`, `native-instance-settings.js`; the new `agent-*.js` files stay in place, nothing imports them).
