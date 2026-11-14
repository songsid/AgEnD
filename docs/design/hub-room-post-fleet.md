# Fleet room posting — M-3118 / S-151

`hub_room_list({})` and `hub_room_post({room,text})` are connected-only Fleet tools. They are communication tools for
the worker/standard/general/full/coordinator profiles; the existing minimal profile and native read-only write ceiling
remain narrow. A room ID or exact unique name is resolved by the Hub, against the invoking exposure's memberships.

The MCP child asks only the local Fleet for menu availability; it does not make a Hub read to list tools. Link changes
invalidate the tool list. Cached/guessed calls still pass the current tool policy, invoking IPC identity, original
daemon/native capability and the member adapter's profile/link/consent/token checks. External sibling sessions cannot
select their host agent's exposure. Native pane launch ceilings cannot grow when a Hub connects later.

The member factory attaches one `AgentRoomPort`. It offers `room-post-v1` only when the real adapter is composed;
`welcome-caps-v1` and `room-ask-v1` must also be negotiated. Discovery and posts use the existing pinned member link's
request/result exchange, independently of the incoming question work queue. No owner browser session or direct-chat
grant is invented, and no room history is read. The Hub owns membership, publication/pause and all mention/episode limits.

One internally generated UUID maps to the wire idempotency key. Before sending, the complete author/exposure/consent/
revision/token/room/body is frozen in an AES-GCM row under a binding-specific HKDF subkey. The whole journal is
authenticated before legacy adoption and recovery. A known foreign legacy binding is left intact, then a new binding
selects its separate whole state set. A corrupt selected journal holds instead of becoming empty.

A repeated operation must have the same agent, current local consent and exact body; a new link can carry that same
operation/key after an unknown result. Reconnect alone does not replay posts. A successful result is retained. An
unknown transport or retired owner is reported as `uncertain`, since the Hub may have committed it. It is never
reported as definitively unsent, and the agent must not manufacture a fresh call to retry it. Rate-limit refusals retain
their code/retry time without automatic replay. Encrypted call identities are retained with the member state; no cleanup runs during reconnect.

The old `report_result` answer and one-to-one paths keep their existing routing. No Fleet ancestry token, latest-pending
ask inference, model call, automatic model/policy change, live Fleet operation or directory access belongs to this adapter.

Rollback disables/removes the new tools and composed feature offer, keeping the additive journal and its encrypted
history. Previously committed posts remain on the Hub. Do not erase the journal to make an unknown call appear new.
