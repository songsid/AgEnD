# PM consent subset review

Lumen cleared the four consent screenshots at b1827bb36 to proceed: the invitation identifies the inviter, agent, room and sharing consequence; the accepted agent page shows In these rooms and owner Leave. The Agree/Decline emphasis, two-person disclosure and phone layouts match the spec. This is subset clearance; Teams, @agent, @all and presence still await the full walk.

The owner page currently contradicts its accepted room membership by saying nobody may ask. When room membership exists and there are no one-to-one grants, the requested lead is:

- zh-TW: 「還沒有人可以一對一提問 · 在 1 個房間裡」
- English: “No one may ask it one-to-one yet · in 1 room”

The count must follow the actual room projection, including owner removal. Under Who may ask, add:

- zh-TW: 「房間裡的人可以在房間裡 @ 它，見「在這些房間裡」。」
- English: “People in its rooms can @ it there. See In these rooms.”

Move In these rooms immediately below Who may ask, before quota. The Invitations page should use the plural title once; its sidebar entry should use the ordinary navigation row with a count badge. Add to the invitation: 「被 @ 時，它會讀到房間最近的訊息。」 / “When @-ed, it reads the room's recent messages.”

These are shared-UI changes. They were sent together to the U1 and U2 owners, with U1 owning the panel summary/placement and shell, and U2 owning the reusable invitation components/strings and room-count callback coordination. Existing HTTP projections suffice; no server route change is requested. Source, tests and screenshots in this packet remain unchanged. Consume the owners' tested public commits and retake the affected actual-server views before closing this follow-up.


Implemented follow-up: verified U1e5ee08c6 and U256bc6367 are combined on source4370f0186. The pm-copy packet records84/8 focused checks, native testType0, and the fresh80/80 actual-server browser retake with22 PNGs. It verifies the one-to-one/room lead, its zero-room update after Leave, one real room read, note/section placement, plural title once, ordinary navigation badge, recent-context disclosure and phone44px targets. The initial phone drawer transition image is preserved separately; six final affected images are visually clear. PM's final subset recheck and the larger Teams/@agent/@all/presence walk remain separate.
