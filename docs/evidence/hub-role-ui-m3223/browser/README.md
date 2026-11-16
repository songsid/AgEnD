# Real Hub role settings

Separate scratch Hub servers run the baseline at `87caabf11` and candidate at `4b34dfac8` plus the tested selected-person label correction. Production initializer, sealed settings, HTTPS listeners, cookie/CSRF sessions, SQLite and UI assets; synthetic AD only. No live Fleet, real account or model call. All browser automation was headless in WSL.

The overview images show the actual viewport of the scrolling workspace. The tab strip scrolls horizontally on a phone. Corrected element screenshots show the full editor; original above-form captures were removed and marked superseded in the receipt.

| View | Before | After |
| --- | --- | --- |
| desk-light-en | [PNG](before/before-desk-light-en.png) | [PNG](after/after-desk-light-en.png) |
| desk-light-zh-TW | [PNG](before/before-desk-light-zh-TW.png) | [PNG](after/after-desk-light-zh-TW.png) |
| desk-dark-en | [PNG](before/before-desk-dark-en.png) | [PNG](after/after-desk-dark-en.png) |
| desk-dark-zh-TW | [PNG](before/before-desk-dark-zh-TW.png) | [PNG](after/after-desk-dark-zh-TW.png) |
| phone-light-en | [PNG](before/before-phone-light-en.png) | [PNG](after/after-phone-light-en.png) |
| phone-light-zh-TW | [PNG](before/before-phone-light-zh-TW.png) | [PNG](after/after-phone-light-zh-TW.png) |
| phone-dark-en | [PNG](before/before-phone-dark-en.png) | [PNG](after/after-phone-dark-en.png) |
| phone-dark-zh-TW | [PNG](before/before-phone-dark-zh-TW.png) | [PNG](after/after-phone-dark-zh-TW.png) |

[English editor, 12 permissions](editors/editors-desk-light-en-editor.png) · [中文角色編輯器](editors/editors-desk-light-zh-TW-editor.png)

[Phone assignment](actions/actions-phone-light-en-assignment.png) · [Checked change summary](actions/actions-phone-light-en-preview.png) · [Stored assignment and audit](actions/actions-phone-light-en-assigned-audit.png)

The actual browser flow searches the company directory, selects Alex, previews the Administrator assignment and saves it through the real writer. A subsequent real role read confirms the stored assignment. The first walkthrough found a missing display label in the preview; the correction has a focused UI regression. The image inspector read all original 18 images, then only the corrected editors and four action images, and found no remaining visible defect.

Receipts: before 11 checks / 8 overview captures; after 25 checks / 8 retained overview captures (2 original editor frames superseded); corrected editor framing 9 checks / 4 captures; focused phone assignment 8 checks / 4 captures. These are overlapping stages, not independent test totals.
