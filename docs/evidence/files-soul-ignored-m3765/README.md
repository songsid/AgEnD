# M-3765: soul.md in an agent's Files, and "Show git-ignored files" (real app)

These are from the real web app (`scripts/manual/smoke-fixture`), headless Chromium. An agent's folder is a scratch git repository with made-up content. It ignores `soul.md`, `node_modules/`, `dist/`, `*.log` and `.env`. The flow is chat ⋯ → **Files & changes** → **Files**; on a phone, the ⋯ sheet's tile.

The script is `scripts/manual/files-soul-ignored-m3765/capture.mts`, the same on each checkout. It covers:
- desk and phone × light and dark × en and zh-TW, on the fleet's own address;
- desk light en and phone dark zh-TW **over the public link**: the real gateway and routes, with only the tunnel and the owner check stubbed.

Results:
- `before/`: release `0e72bcff1`, 18 of 39 checks. `soul.md` is not listed, there is no toggle, and folders show a downward ("expanded") chevron.
- `after/`: this branch at `ac5c1379b` (`src` clean), 69 of 69.

The checks cover:
- `soul.md` is listed and marked "ignored by git", and it opens;
- the other ignored entries are not listed by default;
- with the toggle on, `node_modules/`, `dist/` and `debug.log` are listed and marked, and `.env` is listed but still hidden (not openable);
- tracked files are unmarked;
- the toggle is a 44 px row on a phone;
- folders show a collapsed, right-pointing chevron (the leader's capture check);
- there is no sideways scroll and there are no page errors.

`receipt.json` has every entry seen and each PNG's sha256.

| Frame | Files (in `before/` and `after/`; `link-` = over the public link) |
|---|---|
| The folder's top | `m3765-{desk-light-en,desk-dark-zh-TW,phone-light-zh-TW,phone-dark-en,link-desk-light-en,link-phone-dark-zh-TW}-1-top.png` |
| soul.md opened (after only) | `…-2-soul.png` |
| Show git-ignored files, on (after only) | `…-3-ignored.png` |
