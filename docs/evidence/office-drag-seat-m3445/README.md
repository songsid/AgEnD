# M-3445 (#4266 / #4267) — Office Drag Agent to Seat & Being-Dragged State Evidence

Captured on the real AgEnD web app with `scripts/manual/smoke/smoke-office-drag-seat-m3445.mts` (`RECORD_VIDEO=1`, synthetic agents `Alpha`, `Beta`, `Gamma`, `Delta`, zero real names or chat IDs, zero console/page/CSP errors, zero horizontal overflow across desktop and phone viewports).

## Retained Artifacts

| File | Dimensions / Spec | Size (bytes) | SHA-256 |
| --- | --- | ---: | --- |
| `office-drag-seat-storyboard.png` | 2208×992 PNG (6-panel zh-TW storyboard) | 404726 | `c624b16ce55af8cb4ed5782c6acfac927acf7befeb1694b5a239b65f7f0dfd97` |
| `office-drag-seat-demo.mp4` | 1280×720 H.264 MP4, 25 fps, 26.04 s | 423174 | `ad216735cdc2ca650dee6a839bd8663d6b92448bb89a23608194a7343639cfbc` |
| `desk-mid-drag-custom.png` | 1366×900 PNG (custom `dragged` strip + floor seat rings) | 75149 | `3f48caf2dbc48a8d8a00bd836c84c3f24ade096574c2c4f102b9a27b60a217ee` |
| `desk-cozy-default-dragged.png` | 1366×900 PNG (built-in Cozy skin default lifted dangle + floor seat rings) | 215786 | `db128ed63853b51e1cbfaa72ea119118e5577bcbf02a9b791b100bf08a17870f` |

## What Each Artifact Demonstrates

- **`office-drag-seat-storyboard.png`**:
  1. Before drag: `Alpha` working at desk 0, `Beta` at desk 1, `Gamma` in Lounge, `Delta` heading to Nap.
  2. Mid-drag (custom `characters.<set>.dragged` strip): `Alpha` lifted above its ground shadow in custom waving/kicking pose; floor-level rings sit below desks/characters — bright solid ring on hovered desk 3, dashed rings on other valid Work desks, zero rings in Lounge/Help/Nap.
  3. Dropped on desk 3: `Alpha` seats immediately at desk 3 and resumes working.
  4. After full page reload: `Alpha` persists at desk 3 via per-device `agend_org_office_seats` (`auto@synth-drag`).
  5. Dropped onto `Beta`'s occupied seat (desk 0): `Alpha` takes desk 0 and `Beta` walks cleanly to desk 3; both swapped seats persist.
  6. Built-in Cozy skin (no custom `dragged` strip): `Alpha` plays the built-in lifted, dangling motion above its floor shadow with crisp haloed dashed/solid floor seat rings.
- **`office-drag-seat-demo.mp4`**: Continuous real-app recording covering move to empty desk, reload persistence, occupied-seat swap, and built-in Cozy default dragged animation.
- Also verified in the same smoke run: reduced-motion mode (`prefers-reduced-motion: reduce`) disables and unchecks **Drag and pat**, and the phone viewport (390×844 dark zh-TW) renders cleanly with zero overflow or CSP errors.
