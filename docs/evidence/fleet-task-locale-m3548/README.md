# Fleet task copy (M-3548), main first

The same two defects exist on main and dev: the zh-TW Fleet namespace registers the English `Tasks`/`Teams` labels, and the task-card metadata uses Japanese middle dots (`・`) while the dialog title and English metadata use `·`.

This changes only three zh-TW values: `fleet.tasks` → `任務`, `fleet.teams` → `團隊`, and `taskcard.opened` → `{0} 開的 · {1} · 最後更新 {2}`. English, interpolation, routing, permissions, actions, stored data, markup and styles are unchanged. Other help text's punctuation is outside this footer change.

The prerequisite dev #4367 actually merged as `2e172e7a8b7129182da7dafc514cdca493cc6be8`; its timestamp and fetched alpha ancestry were checked before starting. Main has the same affected strings, so main merges first and a standalone dev twin follows.

## Real app fixture captures

Scratch FleetManager/Scheduler and the real task routes, three generic fixture agents, an Example owner and one Example task. No fleet start, provider CLI or pane calls. Desktop1366×900, phone390×844, Chromium/touch emulation; reduced motion. The footer view is scrolled to the metadata line, not proof of every dialog section or native phone behavior.

| Case | Fleet navigation | Card footer |
|---|---|---|
| Desktop dark zh-TW | [Navigation](desk-dark-zh-TW-nav.png) | [Footer](desk-dark-zh-TW-footer.png) |
| Phone dark zh-TW | [Navigation](phone-dark-zh-TW-nav.png) | [Footer](phone-dark-zh-TW-footer.png) |
| Desktop light English control | [Navigation](desk-light-en-nav.png) | [Footer](desk-light-en-footer.png) |

Capture source is recorded in [capture.json](capture.json). All six images belong to that source; subsequent changes add evidence only. The harness asserts both actual navigation labels and rendered footer interpolation, with no horizontal overflow/page errors/CSP violations. Initial attempts waited for an individual task title on the project-home screen, which does not list that title; those attempts produced no retained images. The successful harness verifies the actual seeded board read and opens the card through its route.

The phone keeps the existing icon-only inactive tab pattern: selected「任務」is visible in the navigation image; the inactive「團隊」label is verified in the rendered DOM, while both labels are visible in the desktop image. All six originals were individually inspected for readability and privacy; no prohibited suffixes, private text or obvious clipping in the captured views.

## Validation and limits

- Actual registered UI dictionaries: base two assertion failures (zh tabs/footer) and two English positive controls; corrected4/4 PASS.
- Source/test typecheck exit0. Changelog assembler206 fragments PASS. Public-content and Gitleaks checks.
- Static capture review does not prove every theme/locale/viewport, all interactions, or native touch/keyboard behavior. No CSS or layout change.

Reproduce with `npx vitest run tests/fleet-task-locale-m3548.test.ts` and the captured environment for `scripts/manual/smoke/smoke-fleet-task-locale-m3548.mts` (`REPO`, `PW_DIR`, `CHROME`, `OUT`, `CAPTURE_SOURCE`). Rollback only the three localized values; no migration.
