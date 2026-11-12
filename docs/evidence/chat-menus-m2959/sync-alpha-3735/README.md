# Plain alpha sync after image annotation

Merge source `a5917327588351e792e834f0929a4574af0d4268` has parents approved menus `8ac895063b4309b83b5d847e529c585a244b6d80` and alpha `0c7ac76a7c9ef59f987ac7159b8e0cb6b1a6072b` (#3735). No rebase or force-push.

Git required one manual conflict resolution, in `chat-workspace.js`; `panel-chat.js` and `app.css` merged automatically. The result retains the menu/favourite/contrast/quote presentation and the incoming image viewer/editor, reply sizing and activity UI.

The quote target retains its raw `name` for annotation ownership while its visible label uses the display name. Its optional `commit` and caller `live` proof, captured source/target identity, mount deadline, synchronous quote+attachment commit and boolean result are exactly alpha's. The [receipt](receipt.json) verifies that quote body after removing only the display-label adaptation. The existing readable-label test additionally pins raw target name; incoming annotation tests are unchanged. [Own changes against alpha](own-overlaps.diff).

All incoming files outside the three overlaps are byte-identical to alpha. No new local suite/build/browser was run during the16–19Z quiet window. Only two `node --check` syntax checks and Git diff checks ran; required exact-head CI and Fable's scoped re-review remain pending. The earlier PNGs/receipts retain their historical source pin. No synced-head visual run is claimed; affected menu/quote legs will be checked after the quiet window if needed for the merged UI.

User already accepted both PR galleries. Coordinator alone merges; parent post-merge green is required for M-2959 confirmation. #3740 will plain-sync only after this parent lands. Rollback is a normal UI revert; no data migration, live fleet, account or directory operation.
