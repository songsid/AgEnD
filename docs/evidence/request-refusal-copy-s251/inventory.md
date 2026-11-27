# S-251 refusal-copy inventory

The only production delta is four EN strings and their zh-TW twins in `REQUEST_CONTEXT_POLICY_COPY`. All policy code outside that dictionary is byte-identical to base `516a4f523`. Codes, branches, roles, approval behavior and real mutation guards do not change. The production flow remains OFF until L.

| Code | Actual refusal | New EN | New zh-TW |
|---|---|---|---|
| `uncovered` | A mutation or Hub answer has no admitted request provenance; ordinary reads and approval-held peer sends keep their existing paths. | Nothing changed: we can't tell who asked for this. | 沒有變更：無法確認這是誰的要求。 |
| `outside` | Non-owner, non-Hub work attempts durable task/schedule/agent/team/shared-rule changes. | Nothing changed: this request can't change tasks, schedules, agents, teams or rules. | 沒有變更：這個請求不能改動任務、排程、Agent、團隊或共用規則。 |
| `settings` | A Hub request or an unknown requester attempts an owner-only action. | Nothing changed: ask the owner to start a new request. | 沒有變更：請由擁有者另外提出這件事。 |
| `broadcast` | A Hub request attempts a Fleet-wide broadcast. | Not sent: choose one agent for this message. | 未送出：請選一個 Agent 接收這則訊息。 |

Other dictionary entries were inventoried and remain unchanged:

- `fleet`, `deferred`: covered by H's retained Fleet-read/task-assignment captures and approved copy.
- `tasks`, `schedules`, `agents`, `teams`, `decisions`: already name the concrete blocked action; their classifier and actual commit tests remain. No new visual clearance is claimed for them.
- `forwards`, `steer`, `audience`: existing concise descriptions of receipt-forwarding, interrupting work and the original Hub conversation; unchanged.
- `stale`, `invalid`: unchanged lifecycle/unsupported-operation errors, outside this four-message round.
- `interrupted`: unchanged approved wording, with card presentation owned by S-249/S-250.

Rendering reuses the existing AgEnD status notice and optional Hub-provenance header from #4500. `uncovered` and non-Hub `outside` must not get a fabricated Hub requester header. No new UI component, CSS, button, layout, icon or instruction/skill publication is introduced. The affected skills do not quote these literals and no how-to behavior changes.

Validation keeps existing role/authority/side-effect assertions and updates only the old `separate owner` text expectations. Captures invoke the actual outbound handler wrapper and `FleetManager.makeRequestContextPolicy`, receive the real refusal/SSE/history projection, and open the real signed-in web chat. Native lifecycle/write sinks are stopped fixture ports so a broken refusal cannot start a CLI or alter a running Fleet. No live Fleet, native pane, account or provider is used.
