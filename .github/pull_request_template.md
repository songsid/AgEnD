## What

<!-- What changes for the user, and why. Link the issue. -->

## Evidence

<!-- Commands run and their results, at this HEAD. -->

## Checklist

- [ ] Rows of `docs/dev/review-checklist.md` that apply are addressed (or marked N/A).
- [ ] A changelog entry under `changes/` (EN + zh-TW), unless a package user would notice nothing (CI, tests, docs).
- [ ] **UI changes only:** follows `docs/design/ui-style-guide.md`; PNGs before and after — desktop + phone, light + dark, EN + zh-TW; shared components named.
- [ ] **UI changes only:** the surfaces the flow supports are stated, and any new click or confirmation is justified.
- [ ] **Keyboard, composer or app-shell changes only:** CI's `keyboard-suite` job is green, and a newly fixed iPhone keyboard bug is added as a case (`docs/dev/iphone-keyboard-suite.md`).
- [ ] User-visible change → updated the affected skill (`src/general-knowledge/skills/…`: web-dashboard / hub / concepts …), or N/A
