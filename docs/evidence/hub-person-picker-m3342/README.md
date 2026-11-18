# Person picker disambiguation

Both Add members and Ask its owner reuse `RoomPicker`. Previously the room
candidate endpoint returned only a person's name and opaque identifier, and the
component rendered that name alone. Identical names were indistinguishable.

The existing endpoint now adds one optional presentation field, `detail`:
department when present, otherwise account; duplicate names in the same
department include the account after a middle dot. With neither value, no second
line is shown. The duplicate comparison covers the returned page. Raw department
and account fields are not forwarded separately. Local cached candidates have
only the account fallback; no department is invented or persisted.

The audience remains signed-in room creators and managers under the existing
endpoint's admission, realm/session fences, query bounds and rate limits. No
new endpoint, search criterion, identity or permission is introduced. Other
search consumers retain their existing response shape because department data
is requested only for this room-picker projection. This new display field and
its audience were disclosed to the product owner and dispatcher before editing.

Person names and second lines each remain one line, with ellipsis and full
`title` text. The accessible name includes both. Selected chips remain name-only;
team, group and agent result rows retain their existing presentation. No new
translated phrase is needed; EN and zh-TW use the same directory-supplied text.

## Validation stages

Four selected controls fail on the baseline after correcting the LDAP transport
fixture: two locale renders, the room projection and the actual directory
adapter's opt-in. Six affected suites pass 49/49 after the change; source and
test TypeScript both exit 0. These are offline and owned HTTP/SQLite fixture
checks, without an operator account or live directory.

The merged-owner compatibility run adds 17 passing tests across two files
(five overlap the earlier stage), including the incoming owner-request UI.
There are 61 distinct tests across stages; merged source and test TypeScript
both exit 0. The sync preserves the search-help footer and single-owner chip.

The actual owned Hub HTTPS/SQLite/audit browser rig passes 39 before and 59
after checks, serially in headless Linux. It records no browser errors or
external requests and sends no Fleet delivery. The inert directory uses only
synthetic people. Temporary homes, browsers and listeners are closed afterward.
A before run serves the baseline renderer and CSS from merge `8047a9ae` with the
same candidate backend; the receipts explicitly record this UI comparison.

All ten after originals and four before originals were opened for visual
inspection. The second lines, duplicate-name accounts, phone ellipsis and
Traditional Chinese interface glyphs are legible; no visual blocker was found.
Metadata fixtures themselves are English. Chips and team/group behavior are
verified in tests/browser assertions, not pictured. Long name/account truncation
is not an image claim.

| View | Before | After |
| --- | --- | --- |
| Desktop EN — Add members | [original](before/desk-en-add-members.png) | [original](after/desk-en-add-members.png) |
| Desktop EN — Ask its owner | [original](before/desk-en-ask-owner.png) | [original](after/desk-en-ask-owner.png) |
| Desktop zh-TW — Add members | [original](before/desk-zh-TW-add-members.png) | [original](after/desk-zh-TW-add-members.png) |
| Desktop zh-TW — Ask its owner | [original](before/desk-zh-TW-ask-owner.png) | [original](after/desk-zh-TW-ask-owner.png) |
| Phone EN — Add members | [original](before/phone-en-add-members.png) | [original](after/phone-en-add-members.png) |
| Phone EN — Ask its owner | [original](before/phone-en-ask-owner.png) | [original](after/phone-en-ask-owner.png) |
| Phone zh-TW — Add members | [original](before/phone-zh-TW-add-members.png) | [original](after/phone-zh-TW-add-members.png) |
| Phone zh-TW — Ask its owner | [original](before/phone-zh-TW-ask-owner.png) | [original](after/phone-zh-TW-ask-owner.png) |

Phone long-department originals: [EN](after/phone-en-long-department.png),
[zh-TW](after/phone-zh-TW-long-department.png). Replay with
`scripts/manual/hub-person-picker-m3342/browser.mts`, supplying a Linux `CHROME`,
`PW_DIR`, a Traditional Chinese `CJK_FONT`, `STAGE=before|after`, owned `OUT`, and
`BASELINE_REF=8047a9ae624b6bd20fe517e2eba211285328325f`.

Risk: directory display labels may be stale or absent. Selection continues to
use the immutable opaque ID, and absence never creates a placeholder identity.
Rollback removes the optional presentation field and two-line person renderer;
no database migration or persistent preference is involved.
