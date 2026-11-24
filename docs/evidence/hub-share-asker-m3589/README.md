# M-3589: askers see a lapsed share

Base: `acf22f6dc` on release/2.3.5-alpha. Owned scratch HTTP/SQLite, synthetic directory and member frames;
no live Fleet, account, CLI, provider/model call or visible browser window.

## Rehearsal and root cause

The new regression changes a real scratch FleetManager agent from Claude Code to Codex. Its incarnation token
rotates; an unchanged neighbor retains its token; A→B→A never restores the original consent. The same lapse
predicate used by the member produces the owner's Needs you entry and the room tools' `share_needs_reshare`
message. The HTTP rig then delivers the catalog lapse and asks from another synthetic person.

On the base, the two fail-first assertions expose the remaining gap: the group placeholder is `working` and the
direct receipt is `queued`. The Hub had stored the owner's catalog lapse, but neither question queue used it.
The member refused old consent, leaving the asker waiting. #4361's owner recovery and room-tool cause were
already present; this PR preserves them and includes runtime in the tool explanation.

After the fix, new and pending asks settle with `share-needs-reshare`; neither new ask reaches the member.
The same reason reaches the direct seam-1 projection, without replacing the asker's question text. Explicit
same-id/next-revision re-sharing restores new questions, retains who-may-ask and expiry, and does not reopen
old terminal work. Wrong catalog owner, Fleet generation or exposure revision cannot block a current share.

## Verification

- Focused tests: 150/150 in 10 files (asker API/UI, #4361 neighbors, representative incarnation, room agents,
  thread, direct reload and rooms).
- Final asker suite: 9/9, including a late member receipt that cannot reopen the terminal question.
- Source and test TypeScript: both exit 0.
- Mutant ignoring all catalog lapses: 5 new failures, 3 positive/binding controls pass.
- Mutant omitting owner/generation/revision binding: the 3 stale-catalog controls fail, 5 others pass.
- Mutant allowing a late receipt to reopen the question: the new late-receipt regression fails.
- Full suite remains CI's responsibility.

## Real-app captures

`browser.mts` serves the actual Hub HTTP implementation and shipped UI over an owned loopback HTTPS listener.
Directory entries and member transport are synthetic. Chrome is headless with an isolated HOME and requests
restricted to the owned origin. Before is the unchanged base; after is this PR. Each run passes 23 assertions
including all 16 viewports' horizontal overflow checks and no page errors (46 total).

All combinations are retained: desktop 1366×900 / phone 390×844, light / dark, en / zh-TW, group / direct.
The 32 originals are named `before|after-device-theme-language-group|direct.png`.

Representative pairs:

| View | Before | After |
|---|---|---|
| Group, desktop EN light | [before](before-desk-light-en-group.png) | [after](after-desk-light-en-group.png) |
| Direct, desktop EN dark | [before](before-desk-dark-en-direct.png) | [after](after-desk-dark-en-direct.png) |
| Group, phone zh-TW light | [before](before-phone-light-zh-TW-group.png) | [after](after-phone-light-zh-TW-group.png) |
| Direct, phone zh-TW dark | [before](before-phone-dark-zh-TW-direct.png) | [after](after-phone-dark-zh-TW-direct.png) |

Style audit: existing chat bubbles and bare status rows, no new CSS or layouts. EN/zh-TW copy explains the
unavailability and owner action without exposing backend, folder or runtime details. Desktop/phone and both
colors use the same shipped components. User look is required before merge.

Recipe (Linux, synthetic only):

```sh
CHROME=/path/to/linux/chrome CJK_FONT=/path/to/cjk-font.ttf PW_DIR=/path/to/node_modules \
  OUT=docs/evidence/hub-share-asker-m3589 STAGE=after \
  npx tsx scripts/manual/hub-share-asker-m3589/browser.mts
```

Run the same recipe with `STAGE=before` and the recipe copied to the base checkout. The assertions and screen
proof do not claim a live daemon, backend CLI or actual model response.

Rollback: revert this PR; no migration or changes to consent, grants or incarnations. #4361's existing Share again
remains available.

## Phone notice wrapping correction

The initial phone direct status used the thread's default folded line, hiding the re-share action behind More.
The existing `wrap: true` presentation flag now applies only to the lapsed-share direct notice and group progress
notice. Copy, CSS and the queue/consent code are unchanged. Both locale regressions fail before these flags and
pass after; the UI/thread neighbors pass 51/51.

All eight after-phone originals were re-captured (both colors/languages, group/direct). The separate
`receipt-after-phone-wrap.json` records 23 checks, including all eight notices fully wrapping without a folded
class or More control, plus horizontal-overflow checks. The original desktop captures and initial matrix
receipts remain as recorded; no desktop or backend campaign was repeated.
