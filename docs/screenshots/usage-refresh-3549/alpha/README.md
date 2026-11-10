# Alpha continuation

Independent alpha run at4b80b9ca4:66/66 focused tests;8 real Chrome cases (4 current +4 beta.3 cached CSS/strings),12 original PNGs here. Viewports1366 desktop light and340 phone dark, EN/zh-TW. All cases show updating alone on one line and restore the same idle age, no console/CSP/overflow. Synthetic API snapshots, no vendor/live fleet/account.

The production added/removed lines in both UI files exactly match main84f4da740, despite alpha's pre-existing usage-meter split. Source/PNG digest-first manifests pin this alpha capture. Parent gallery's4 before PNGs are main baseline evidence; no independent alpha-before claim. Cached English retains the single older Refreshing… label.

All12 alpha PNGs were visually inspected. The usage card has no clipping/overlap/tofu. One unrelated held-strings limitation is visible in skew-desk-light-en-updating.png: alpha sidebar shows VIEW.GENERALGROUP because the deliberately cached beta.3 strings lack that newer sidebar key. Current-shell images translate it. This card change adds no key/import and does not repair that separate shell compatibility issue.
