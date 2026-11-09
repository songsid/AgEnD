# AD connection editor evidence

- `after/`: desktop/phone × light/dark × EN/zh-TW, both the real Settings → Hub section and Hub Administration sub-page. Each has form, lower actions and native trust dialog.
- `before/`: the same eight cases on actual pre-editor server/UI `31a973af`, without API or module replacement.
- `recovery/`: English phone, old AD down, anonymous CA refusal/service-only retry, derived CA confirmation and saved off-state. The recovery receipt also covers the actual local Run switch stopping while AD is down, saving while off, optional Test with no epoch effect, same-host Save and Run again.
- `matrix-original.json` records the original complete eight-case run. `phone-english-final.json` records the targeted English phone recheck after wrapping long captions. The corresponding images in `after/` are the final captures. The phone-only wrapping CSS leaves desktop paint unchanged.
- `before-first.json` and `before-remaining.json` together cover all eight genuine before cases without repeating the initial two.
- The three `skew-*.json` receipts use retained modules, retained host HTML, and an actual earlier server with new static modules. They assert no editor/private reads where a capability is absent; old-shell keeps a current Hub positive control. No API replies are stubbed.
- `checks.json` records focused/type/gate results and the earlier isolated local compose timeout. `mutations.json` records source images and assertion failures for the 26 guards, with the targeted lifetime retest explicitly distinguished.

The browser rig and copyable recipe are in `scripts/manual/hub-directory-editor/`. Every run closes its own browser, listeners, controller/runtime and scratch home. No real directory, account, pilot, live fleet, CLI, native service or production deployment was used. Passwords are dummy fixture inputs; screenshots show them only empty or masked. Public endpoints are generated loopback fixtures.
