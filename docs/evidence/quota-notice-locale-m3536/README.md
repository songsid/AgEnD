# Quota notice summary locale — M-3536

The effective quota summary previously printed stored period codes directly. zh-TW now displays 工作階段、每小時、每日、每週、每月 and a full-width colon. English output and editable/stored period codes are unchanged. Existing Settings card/`.note` presentation is reused; no layout or permission change.

`desk-light-zh-TW.png` is the real main web app, Chromium desktop/light/zh-TW, isolated scratch FleetManager with synthetic fixture names. No agent or provider is started. `capture.json` pins the source commit and checks summary text, horizontal overflow and CSP. This is a static capture, not native-device or provider evidence.

Reproduce with `scripts/manual/smoke/smoke-quota-locale-m3536.mts` using the documented smoke fixture REPO/PW_DIR/CHROME/OUT environment. Tests: quota-notice-draft-3299 and quota-notice-integration-3299, 7/7 PASS. Regression checks pin all five zh labels, empty-period dash, unchanged English output and unmodified input codes. Changelog assembler PASS.

Rollback: revert the copy/render and test change; storage and runtime behavior need no migration. Dev twin follows the actual main merge because main has the same component.
