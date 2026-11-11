# Export an agent's settings, and Load template — before and after

Drawn in the real web app, in a headless browser, against two scratch fleets (each with its own `AGEND_HOME`, loopback only, no chat channel): one built from `release/2.3.5-alpha` @ 1066a85a2 ("Before", #3626 merged), one from this branch ("After"). Both have the same agent, `claude-kasa`, with a description, tags, a model, the `coordinator` tool set and a multi-line Markdown `systemPrompt` (the Agent instructions).

For each of the 8 cases (`{desktop,phone}-{light,dark}-{en,zh-TW}`; desktop 1280 wide, phone 390 wide):

- `before-basic-<case>.png` — *Settings › Basic info › Agent instructions* on the base: no Export, no Load template.
- `after-basic-<case>.png` — the same card on this branch: **Load template** and **Export** under the field, with a line saying what a template holds.
- `export-<case>.png` — the Export dialog: what to include, the live preview of the `<role>.agend-agent.yaml` file, Copy / Download, and the list of what is never exported.
- `load-<case>.png` — the Load template dialog after **Check** on a file that was edited by hand to carry `working_directory`, `channel_id` and `skipPermissions`: what will be filled in, and what is skipped, each with its reason. (The pasted text is scrolled out of view to show the result; the full dialog is `load-input-desktop-light-en.png`.)

Also:

- `load-input-desktop-light-en.png` — the Load template dialog before Check (the pasted file).
- `load-fileref-desktop-light-en.png`, `load-fileref-phone-dark-zh-TW.png` — a file whose Agent instructions are `file:~/.ssh/id_rsa`: skipped, with the reason (the daemon would read that path on the loading computer).
- `filled-desktop-light-en.png`, `filled-phone-dark-zh-TW.png` — after **Fill the form**: the values are in the form (nothing is saved; the Save bar and its confirmations apply as always).
