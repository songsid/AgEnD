R1: mention labels stay inside the readable Discord room

Review found that the initial per-message projection could turn a guest's own text, or a private-room echo, into a lookup of Fleet-wide cached names. The earlier packet is superseded for this behavior.

The repair at source `9772fada5`:

- Skips `mine` rows and rows without the shared-channel mark before querying any names.
- Maps the instance to its exact configured connection and channel, with no primary-bot substitution or Fleet-wide seen-user fallback.
- Reads only that channel's guild members and roles. It requires a cached viewer and read permission for the source room, and for every channel whose name is returned. Other guilds, unreadable channels and private threads without cached membership produce no names.
- Keeps the lookup endpoint closed. A missing adapter, guild, viewer, permission or name uses the existing fallback, without a network request.
- Pins the null-fetch path: it settles without a rejection or repeated fetch.

Fail first: guest-owned history/poll and private-room echo checks fail by assertion on the previous source; the null-fetch control passes. Eight unselected checks are excluded. After the repair, 49/49 pass across the three focused suites. The final new suite passes 14/14 after the private-thread pin and stronger channel-posted own-row probe; 13 overlap, so there are 50 distinct checks. Removing only the `!mine` guard produces one assertion failure with 13 unselected checks; exact source restore returns all 14 to green. Source and test native TypeScript exit 0.

The focused after retake uses the actual web HTTP/session/history/rendering path and the actual Discord adapter cache reader over synthetic guild, member, channel and permission caches. It starts no Discord client or Fleet lifecycle. Both admin and guest show `@Avery @Blair`; guest lookup count is zero, including live/unknown/reload, and another chat remains 404. Both new original PNGs were independently inspected with no visible layout or privacy regression. Initial before images carry unchanged; no matrix was repeated. All browser work was headless in WSL, and the owned browser/listeners closed before the slot was released.

`manifest.json` binds the source inputs and artifacts, including the losslessly compressed, path-sanitized logs. Rollback remains an ordinary revert, with no migration. Missing cache data may leave a mention unnamed; it must never widen the lookup.
