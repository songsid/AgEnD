# Fleet room posting — M-3118 / S-151

`hub_room_list({})`, `hub_room_members({room})`, `hub_people_search({q})` and `hub_room_post({room,text,receipt_id?})` are connected-only Fleet tools. They are communication tools for
the worker/standard/general/full/coordinator profiles; the existing minimal profile and native read-only write ceiling
remain narrow. A room ID or exact unique name is resolved by the Hub, against the invoking exposure's memberships.

The MCP child asks only the local Fleet for menu availability; it does not make a Hub read to list tools. Link changes
invalidate the tool list. Cached/guessed calls still pass the current tool policy, invoking IPC identity, original
daemon/native capability and the member adapter's profile/link/consent/token checks. External sibling sessions cannot
select their host agent's exposure. Native pane launch ceilings cannot grow when a Hub connects later.

The member factory attaches one `AgentRoomPort`. It offers `room-post-v1` only when the real adapter is composed;
`welcome-caps-v1` and `room-ask-v1` must also be negotiated. Discovery and posts use the existing pinned member link's
request/result exchange, independently of the incoming question work queue. No owner browser session or direct-chat
grant is invented, and no room history is read. Members are current people/agents/presence in the invoking agent's rooms.
People search reuses the owner's existing own-exposure person picker, with only ID/name/login, the existing read pool,
bounds and server rate limits. The Hub owns membership, publication/pause and all mention/episode limits.

One internally generated UUID maps to the wire idempotency key. Before sending, the complete author/exposure/consent/
revision/token/room/body is frozen in an AES-GCM row under a binding-specific HKDF subkey. The whole journal is
authenticated before legacy adoption and recovery. A known foreign legacy binding is left intact, then a new binding
selects its separate whole state set. A corrupt selected journal holds instead of becoming empty.

A repeated operation must have the same agent, current local consent and exact body; a new link can carry that same
operation/key after an unknown result. Reconnect alone does not replay posts. A successful result is retained. An
unknown transport or retired owner is reported as `uncertain`, since the Hub may have committed it. It is never
reported as definitively unsent, and the agent must not manufacture a fresh call to retry it. Rate-limit refusals retain
their code/retry time without automatic replay. Encrypted call identities are retained with the member state; no cleanup runs during reconnect.

## Posting for a person and answer notifications

Only when a Fleet administrator instructs the invoking agent to post for them may the agent supply that instruction's
canonical full `hmsg-UUID` as `receipt_id`. The Fleet reads the real stored receipt through target/explicit-forward access,
requires delivered positive owned proof and intact original/wire hashes, and rechecks current admin and web authority.
A platform admin must belong to the invoking agent's adapter namespace. The host/operator account qualifies only on a
web-only Fleet with still-current verified authority. Peer text, guest/unverified web messages, raw paste, revoked authority,
abbreviated IDs and model-supplied person/name fields do not qualify. Receipt text is not sent to the Hub.

The verifier proves a current Fleet-admin instruction; it does not claim that a platform actor is the same AD account.
The approved product policy attributes the post to the current paired `link.owner`, shown as X via agent. The agent's room
membership suffices even if the owner is not a room person. The Hub retains one human episode root per owner+receipt;
reuse does not repeatedly reset depth. `@all` still requires the room's allMention setting or that owner's room-manager
right. Five actions per source agent/minute and 30 per room/minute remain in force; the post and each routed mention count. Receipt identity is frozen with the post.

An accepted original post ID maps back to the exact saved invoking agent/exposure/consent/lifecycle. A `room.post-answer`
notification carries the Hub's retained original idempotency key and must match that frozen intent, room, exposure and
optional receipt. If the result was lost, this authenticated frame establishes only the canonical post/room mapping; it
does not manufacture an original post timestamp or a successful RPC result. Unknown operations, changed canonical mappings
and old consent are refused. Each exact notification is encrypted before delivery and records input intent immediately
before the normal Fleet handoff. Successful delivery persists before its exact ACK; a lost ACK retries without another
input. Interrupted or uncertain input is held, never replayed. Reconnect alone does not execute queued local history.
The message includes original post/receipt IDs so the invoking agent can relay the answer to the person. It is a notification,
without a new `report_result` obligation. Current consent still gates delivery and ACK. Delayed delivery failure retires the
local notification. Held replies are logged by notification ID; they do not claim exactly-once consumption by a vendor CLI.

The old `report_result` answer and one-to-one paths keep their existing routing. No Fleet ancestry token, latest-pending
ask inference, model call, automatic model/policy change, live Fleet operation or directory access belongs to this adapter.

Rollback disables/removes the new tools and composed feature offer, keeping both additive journals and their encrypted
history. Previously committed posts remain on the Hub. Do not erase the journal to make an unknown call appear new.
