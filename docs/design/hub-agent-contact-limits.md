# Hub question contact limit

M-3160 implements setting B from Lumen's design at `673782a40`, approved by the owner. Per-agent contact allowlists, Hub General and MCP agents are outside this change.

In Fleet **Settings → Hub → Shared agents**, **While it answers a Hub question, this agent may not contact other agents** defaults on. Existing shares also default on. A persistent Settings notice names the setting and where to turn it off; the owner acknowledges it once per Hub membership. Publishing or revising the choice uses the existing sharing confirmation and revision check. The choice is local Fleet policy, not a new Hub wire field.

Each direct or room question opens an independent window at the connected input handoff, before possible IPC exposure. It lasts 30 minutes or until a valid answer is accepted, whichever comes first. This duration was confirmed by Lumen. Retries do not extend it. A malformed answer does not close it. Overlapping questions keep the restriction until every window is closed/expired. The Fleet persists windows separately from the member service, so disconnecting, disabling Hub membership or restarting cannot silently remove them. An uncertain handoff retains its window; no question is resent. Existing protocols have no per-question cancellation notification, so expiry bounds abandoned questions without adding a new signal.

The shared outbound send handler refuses `send_to_instance`, `delegate_task`, `request_information` and peer-directed `report_result`; the broadcast handler refuses the entire broadcast before admission. This covers MCP, agent CLI and direct IPC calls. `agend-hub` remains reachable for answers. `hub_room_post` has its own limits and is unchanged. The refusal says why and tells the agent it can retry after answering.

This closes a direct contact path, not all access to the Fleet's information. The agent keeps its own tools/folder, may remember earlier information, and can contact other agents after the window ends (including after 30 minutes even if still answering). An owner's unrelated work can also be refused during the window and must retry. No backend launch/tool catalog is changed.

The local window file contains agent names, opaque correlation IDs and deadlines only, with private permissions and atomic writes. Missing file means no windows; malformed/unreadable state refuses contact and new Hub input until repaired. The setting remains on by default when an older Settings client omits the new field.

## M-3660: only the answer turn (2026-11-24)

The live m365 case on beta.21: an answer refused as "no longer open" held its question, but the window stayed for its 30 minutes and refused every agent message in every turn, the owner's included. The user's direction:

- **A Hub question is a turn of its own.** The agent's daemon writes it only into an idle pane: never into a running turn through the CLI's native queue or a busy composer, which Claude merges into the running work. While the Hub answer turn runs, other deliveries wait for it too.
- **The window covers that turn only.** The daemon sends `hub_question_input` just before the write, which opens the window, and `hub_question_turn_ended` at the idle edge after the turn has worked or just before the next write, which closes it. A question waiting behind the owner's turn blocks nothing. A ClassicBot room is idle-gated by the Fleet and opens its window there, as before.
- **A settled question ends its window at once:** a representative question held (withdrawn, revoked, expired, replaced, uncertain) or released, or a room ask answered or acked. A held room ask still takes a late answer, so its window runs on. With no member service attached (the Hub off or disconnected), a window holds until it ends or expires, because its question's fate is unknown.
- **30 minutes is only a safety cap,** for a turn whose end was never seen.
- **The refusal inside the turn says why** and that contact works again from the next turn. A labelled pass-through inside the turn is M-3661.

The earlier paragraphs' "at the connected input handoff" and "an owner's unrelated work can also be refused during the window" no longer hold.

