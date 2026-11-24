# Agent activity: a person's side and an agent's (M-3674)

A user saw "33 天" on a busy agent. That agent was working all the time, but only on turns that other agents started.

## Where the time showed, and what fed it (before)

| Where | Field | Source | Agent-started turns |
|---|---|---|---|
| Dashboard sidebar: the row's time, the "Recent" sort, the fresh-reply glow | status frame `last_reply` (a guest's: `last_reply_channel`) | `webChatHistory.lastAgentReply`: the newest `role: "agent"` message, i.e. the last reply to a person | never counted: messages between instances are not written to the web chat history |
| `agend ls`, "Activity" | `/api/fleet` `lastActivity` | the persisted last human inbound, else the in-memory `touchActivity` | never counted |
| MCP `list_instances` / `describe_instance` | `last_activity` | `touchActivity`: a person's message, or the instance's own tool call | another agent's message to it never counted |
| Org chart, office card, Details | — | no activity time | — |

## After

- **Agent side:** `DeliveryOutbox.lastAgentTurn(instance)` gives the latest activity time among all the kept delivered messages from another instance (a send_to_instance task, report, query or update, a steer, or a broadcast). The time is the turn that took it up (`consumed_at`), or the delivery time if it hasn't been taken up yet. Queued, failed and cancelled messages don't count, and neither do the instance's own messages to itself or messages from a person. It reads a partial index (`idx_delivery_agent_turn`) ordered by that time for each agent, from the newest end, so an old message taken up late counts however many newer ones came after it, and no history is scanned or sorted.
- **Status frame:** gains `last_agent_turn` next to `last_reply`. A guest's status doesn't carry it, because it describes the fleet's own traffic.
- **Sidebar:** shows both times, each labelled, and the tooltip names each one with its full time. A reply on its own reads as before. In the one-line desktop sidebar (the default "compact"), the newer of the two shows, labelled, so the name keeps its room; both stay in the tooltip.
- **`list_instances` and `describe_instance`:** gain `last_agent_turn` next to `last_activity`. In **`agend ls`**, the Activity column reads `2d ago · agent 3m ago`.

## Captures

These are the real dashboard in headless Chromium, using the smoke fixture. There are three fixture agents, and no real names:

| Agent | Last reply to a person | Last turn another agent started |
|---|---|---|
| Busy helper (the reported case) | 33 days ago | 2 min ago |
| Chat helper | 5 min ago | none |
| Relay helper | none | 3 h ago |

The agent side is supplied as the fleet reads it (`lastAgentTurnOf`). `tests/activity-split-m3674.test.ts` covers the outbox query itself against a real SQLite outbox.

- **Before:** `3ed153b1`.
- **After:** this branch's source (named in `after-report.json`).

| Case | Before | After |
|---|---|---|
| Busy helper, desk compact (en / zh-TW) | `33 d ago` / `33 天前` | `Agent 2m` / `Agent 2 分` (the newer one); the tooltip has both |
| Busy helper, desk detailed and phone (en / zh-TW) | `33 d ago` / `33 天前` | `Person 33d · Agent 2m` / `人 33 天 · Agent 2 分` |
| Chat helper | `5 min ago` | `5 min ago` (unchanged) |
| Relay helper | no time | `Agent 3h` / `Agent 3 小時` |

In every case, no agent's name is cut and every time is whole in its row (`nameCut` and `timeWhole` in the reports). The phone captures open the drawer for real (`#sbOpen`, "Open the sidebar"). Every phone row is asserted on screen, `visible` meaning that `elementFromPoint` at the row's centre is the row itself; the run fails otherwise. These phone pairs were re-captured for Prism's #4430 review, and their source is `source_phone` in `after-report.json`. No run had page errors or CSP violations.
