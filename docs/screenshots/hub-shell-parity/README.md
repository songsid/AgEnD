# Hub shell parity (#3431)

The Hub's sidebar and page frame, before (`songsid/release/2.3.5-alpha` at `109433b91`) and after (this branch), drawn by
the Hub shell gate (`scripts/manual/smoke/smoke-hub-shell-gate.mts`, `GATE=full`) on a real Hub web listener: HTTPS on
127.0.0.1, the s3b rig (scratch SQLite, a fake directory, an in-process member that publishes two agents), the
administrator signed in. No fleet runs, no network. The Notices page needs a Hub that offers its security notices; the rig
composes none, so the session's capability mark and one notice are answered in the browser (`page.route`).

- `before/<case>-sidebar.png`, `after/<case>-sidebar.png`: the Chats page, all eight cases (desk/phone × light/dark ×
  en/zh-TW); on a phone the drawer is open.
- `before/` and `after/` `desk-light-en-admin.png`, `phone-dark-zh-TW-admin.png`: Administration. Before, the notices
  card wears another frame and spans past the page's column.
- `after/` only: My shared agents, Notices (desk and phone), the session menu and Settings opened from the foot.

Gate verdicts: before, 240 checks fail (brand, rows, row shape, current row, Search, New chat, list, foot, menus, card
frame, notices in the column; the Notices page does not exist); after, 512 checks pass. The existing Hub UI gate
(`smoke-hub-ui-gate.mts`, #3424) passes on the branch at `GATE=full` (314 checks) with the tap-target list unchanged.
