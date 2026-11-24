# A lapsed share answers the asker (M-3589)

#4361 already detects a changed backend, working folder or runtime. The owner has Needs you and Share again;
room tools return `share_needs_reshare`. Consent remains bound to the exact incarnation (#3147).

The remaining gap was on the Hub: its owner-only catalog retained the lapse but its question queues did not use it.
A group question showed a working placeholder and sent `room.ask`, which the Fleet refused. A direct question
returned a queued receipt. Neither told the asker that the owner needed to re-share.

The Hub now uses an exact current-owner, Fleet-generation and exposure-revision lapse report to **refuse only**.
It settles pending group deliveries and direct questions, including a lapse reported after enqueue. New questions
are recorded with the same explicit terminal reason, `share-needs-reshare`, without sending them to the Fleet.
The viewer's language supplies the explanation; no private backend, folder or runtime details reach askers.

An old catalog from another owner, generation or exposure revision cannot retire a current share. No catalog
report issues consent or restores an old question. An explicit Share again uses #4361's same-id/next-revision
publication and original who-may-ask/expiry carry; new questions then work. Terminal questions stay terminal.
The existing member-side token fences still refuse stale consent even before a lapse report reaches the Hub.
Older Hubs retain their prior behavior; no new member capability or wire frame is required.

The room uses the existing no-answer bubble and direct chat uses its existing terminal status row. No markup,
layout or CSS changes. Copy is EN/zh-TW, uses Agent and Hub consistently, names the recovery action, and includes
no private paths or operational details, following `ui-style-guide.md` sections 1, 6, 8, 10, 11 and 13. The browser
recipe exercises actual Hub HTTP/SQLite/UI with an inert directory and member, on loopback HTTPS only.

Rollback: revert this PR. No migration, consent, grants or incarnation data is changed; #4361 recovery remains.
