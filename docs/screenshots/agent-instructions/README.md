# Agent instructions (the old System prompt, in Basic info) — before and after

Drawn in the real web app, in a headless browser, against two scratch fleets (each with its own `AGEND_HOME`, loopback only, no chat channel): one built from `release/2.3.5-alpha` @ 861ca2ac4 ("Before"; the later alpha commit, #3629, changes only how pending summaries are worded and touches none of these pages), one from this branch ("After"). Both have the same two agents. `claude-kasa` has a multi-line Markdown `systemPrompt`; `reviewer` has `systemPrompt: "file:prompts/dev.md"`.

- `agent-instructions-{desktop,phone}-{light,dark}-{en,zh-TW}.png` — the 8 cases (desktop 1280 wide, phone 390 wide; light and dark; English and Traditional Chinese). The two builds side by side, "Before" on the left: the System prompt in *Settings › Advanced* (a one-line box that runs the lines together), and after, the same text in *Settings › Basic info › Agent instructions*.
- `advanced-after-desktop-light-en.png` — Advanced after: the System prompt card is gone from it.
- `preview-{desktop,phone}-{light,dark}-{en,zh-TW}.png` — the card on its **Preview** tab (the chat's Markdown look), with the counter and the notes under it.
- `preview-file-desktop-light-en.png`, `preview-file-phone-dark-zh-TW.png` — a `file:` reference in Preview: it is shown as the file it names, not read.
- `confirm-card-light-en.png`, `confirm-card-dark-zh-TW.png` — saving a change to a long text: the confirmation shows the length, a fingerprint and the first words of the old and the new text, never the whole of it. (Both drawn with the fleet running in English: the Chinese one is the page's language, as #3629 does for the other summaries.)

## SKEW

`skew-{A,A2,B}-{desktop,phone}.png`: the real app in a headless browser, signed in, on a build of this branch whose served files (`dist/ui/…`, read per request) were swapped for the ones from `release/2.3.5-alpha` @ 9abdfa67f; each image shows the agent page at `?cat=basic`, at `?cat=adv`, and Settings → Agents → the agent's dialog. After every leg the files were put back and compared byte for byte with the build.

- **A** — the base's shell (`shared/instance-nav.js`, `shared/view-strings.js`, `shared/app-i18n.js`, `shared/app-shell.js`) with this branch's panels.
- **A2** — A, and the base's `shared/app.css` too (what an old tab really holds).
- **B** — this branch's shell with the base's panels (`settings-dialogs.js`, `agent-details-settings.js`, `agent-page-strings.js`, `panel-fleet.js`; the new `agent-instructions-field.js` stays in place, nothing imports it).

Each leg also typed a value into the prompt field on the page it showed and pressed Save, and checked that `fleet.yaml` has it.
