# M-3433 (#4256) Real-App Verification Evidence

Captured on the real AgEnD web dashboard (`scripts/manual/smoke/smoke-office-card-style-m3433.mts`) using synthetic skin packs (`rpg-sheet`, `compact-studio`, plus built-in `cozy`) and a synthetic roster (`Alpha`, `Beta`, `Gamma`) with zero real instance names, usage data, or host paths.

## Retained Captures

| File | Dimensions | Bytes | SHA-256 | What it shows |
|---|---:|---:|---|---|
| `office-card-style-board.png` | 1272×1530 | 339,403 | `3afac5e634ef9f4d6de3b0f66ccd748f2fbcb10996838337e46673940517ed53` | 2×2 comparison: (1) Default Cozy card (320 px, single-line `今天`, 8.59:1 labels), (2) RPG dark zh-TW card with 9-slice frame + 84×84 portrait + textured background (10.79:1 labels), (3) Compact light EN card (296 px, 44 px avatar, 1-row buttons, 9.42:1 labels), (4) Phone 390×844 RPG bottom sheet. |
| `desk-rpg-zh-card.png` | 1366×900 | 135,649 | `aba1139a16392edd4b377ae78af705367066bbcc1211563c9c3d3822f322d0a7` | Full desktop viewport (zh-TW dark) showing 340 px RPG card clamped inside stage, 84×84 portrait with 4-sided 1 px gold border, 9-slice frame, high-contrast field labels (10.79:1), and single-line `今天` stat box (`1.8M 工作 token · 64 次請求`). |
| `phone-rpg-zh-card.png` | 390×844 | 86,524 | `14c24de6aa16b94a266343de34ce63cebe785f490f3d1870341004c40dbc9cc1` | Full phone viewport (zh-TW dark) showing full-width RPG bottom sheet (`<= 75dvh`), swipe grip, 44×44 px Close and action buttons, high-contrast labels, single-line `今天`, and zero horizontal overflow. |
