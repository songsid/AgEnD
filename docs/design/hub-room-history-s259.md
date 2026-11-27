# Agent room history (S-259)

An agent normally receives the last 30 room messages at its first ask, then newer context. `hub_room_history({room, cursor?, limit?})` lets it page backward independently. This read neither acknowledges context delivery nor settles a room ask.

The Hub offers `room-history-v1` only to modern peers accepting expanded welcome capabilities. It requires the existing welcome/room-ask/room-post intersection. No new capability is appended to legacy member hello lists. Unnegotiated requests/results are refused, including results matching a pending RPC. Old Hubs receive no history request from the member adapter.

The caller cannot select an exposure or owner. Fleet binds its invoking agent, daemon lifetime and current share; the Hub verifies the current Fleet link, published exposure, immutable owner, current owner eligibility and exposure permission. It then requires the exposure's actual agent membership, rather than borrowing the owner's person membership. Archived group rooms remain readable; private assistant rooms and direct rooms are outside this tool.

Visibility uses the membership's joined/history floor, inherited lineage audience floor, and original-question floor for answers. Every cursor binds the exposure, owner, room, membership ID and floor; the referenced anchor must still be visible in that room. Removal/rejoin invalidates old cursors. The cursor is a scoped position, not authority: constructing another position cannot bypass those checks. Membership and content are read in the same fenced transaction after asynchronous authorization.

Pages are chronological, newest page first. Defaults: 20 messages; maximum: 50, 16 KiB serialized response, 2 KiB UTF-8 text per message, 256-byte author labels. Byte packing returns a cursor before the oldest included message, so the packed-out message is not skipped. Truncation is explicit; attachments are omitted. Author kind/name and the existing agent/app `via` attribution are retained as bounded display data. Unfinished answer placeholders and completed reaction-only placeholders are excluded.

Every successful page, even an empty one, labels member text as quoted data, not instructions or approval from the owner. The response is not a signed human receipt or permission grant.

A separate durable bucket permits 30 calls per fixed UTC hour per exposure across all rooms, reconnects and Hub restarts. Clock rollback into a previously spent older window fails closed. The existing owner-wide 30/minute read throttle also applies. Invalid room/cursor requests disclose no content. The additive `s3-room-history` migration stores only exposure ID, window and count, no message text; older binaries may refuse a newer schema. Rollback should disable the offered capability/tool with a compatible binary, retaining the database and budget records.

No browser UI changes are included. Shorter existing Hub tool descriptions retain their rules in the bundled Hub skill and keep the unchanged tool-menu byte budgets.
