# M-3559: the sidebar's 搜尋 / Search label never gives way to its Ctrl K hint (real app)

Captured from the real Hub and its real UI, headless Chromium, desk 1366 px wide; "before" is plain alpha 39aff523e and
"after" this branch. A short window (408 px tall: the sidebar's nav rows sit two to a line) and a tall one (900 px), and a
sidebar at its narrowest (184 px). zh-TW and en, light and dark; each picture is the sidebar's top.

| Case | Search row | Before | After |
|---|---|---|---|
| short window, two to a line | 122 px | label cut (「搜.」, "Se…") beside Ctrl K | label whole, no hint |
| tall window | 244 px | label and Ctrl K | the same |
| narrowest sidebar | 184 px | label and Ctrl K | the same |

Measured per case in the browser (row width, the label's scrollWidth against its clientWidth, the hint's width): every
"after" case has its label whole; the hint shows wherever the row has about 140 px inside its padding, and goes only in
the two-to-a-line rows. The row's title still names the shortcut (「搜尋 (Ctrl K)」).
