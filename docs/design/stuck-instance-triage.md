# Stuck agents: General checks first, restart second (#2778)

Status: **design for review. No code yet.** The user approved the direction (Discord button hmsg-012cbb90). The
user-facing strings in §7 go to the user before any code is written.

## 1. Why

Today, a pane that looks frozen while the agent still has work posts one prompt in the agent's own topic:
「⚠️ X 可能卡住了 — 畫面已 N 分鐘無變化，也偵測不到就緒提示」, with 🔄 強制重啟 / ⏳ 繼續等待. General only shows
the line 「沒有回應」 in the 📥 等你處理 list. That prompt has three problems:

- It says *that* something is wrong, never *what*. To learn the cause, someone has to open the pane or ask an agent to
  look.
- Its first answer is a restart. That is often wrong. On 2026-10-27 the leader's main session was idle while three
  background subagents ran (#2769): its messages queued behind a paste waiting for an idle prompt that the subagent
  timers never let it see. A restart would have killed the subagents and dropped the queued messages. Waiting, or
  stopping the subagents, was the fix.
- It misses the cases that matter and flags ones that don't:
  - The 2026-10-27 stall raised no prompt at all, because the moving timers made the pane look busy, not frozen.
  - A ~100 s blip after start-up (m365, 20:21 and 22:17 that night) put "可能卡住" on the dashboard and then cleared
    by itself.

This design puts another agent between the alarm and the remedy. General looks first (read-only), says in plain words
what is wrong, and offers only the actions that diagnosis supports.

## 2. Triggers (what counts as "suspected stuck")

A **ticket** opens for target T when either signal holds, and §3 lets it through:

| Signal | Source | Default |
|---|---|---|
| **A. Frozen with work** | the existing `handleStuckTransition`: instance state `stuck` and `pendingWork` | pane unchanged ≥ `hang_detector.timeout_minutes` (10) |
| **B. Lane held** (new) | the delivery outbox: T's head-of-line row in `delivering`/`submission_started`, or a human message waiting in T's paste queue | ≥ 10 min (`stuck_triage.lane_minutes`) |

B is the 2026-10-27 shape: the pane is moving, but nothing gets through. It reuses the facts the 35-minute
`delivery.lane_waiting` alert already reads. That alert becomes a ticket of its own, and its fleet-error text is
retired.

There is one ticket per target. A second signal while a ticket is open only adds to that ticket.

## 3. False-alarm rules (no ticket, or the open ticket resolves)

1. **Background agents only.** A claude-code pane whose only motion is in Claude's session list (`  ● main` /
   `  ◯ <agent> … 3m 6s · ↓ 56.8k tokens`, recognised as in #2771) with an idle box is idle: no A. B still applies, so
   messages that really are held still show. This is #2770 (ii).
2. **#1641 self-recovery.** No ticket while the stuck-recovery window is running (idle composer and no open
   transcript turn, held `UNKNOWN_LAYOUT_STABLE_MS`). A ticket opens only after that window ends without recovery.
3. **Start-up.** No ticket within 3 min of a spawn or launch attempt (the m365 blips).
4. **Already told.** No ticket while T is: paused; in a planned restart or update; in a storm window; on a known dialog
   (it has its own prompt); holding an unresolved auth failure (the auth alert owns that); or on a rate-limit wait the
   backend reports (`Retrying in…`, usage limit).
5. **Recovery.** The ticket resolves on its own when:
   - for A, T leaves `stuck` (a turn starts or ends, or the composer is back and idle) and stays out of it for 60 s;
   - for B, the lane's head row reaches a terminal state, or its queue drains.

   The notice is then edited to §7 S8, and its Needs-you item is withdrawn with the reason "cleared by itself" (§6).

## 4. Flow

```
signal A/B ─▶ §3 rules ─▶ ticket (id, target, signal, since) ─▶ notice in General  [🔍 請 General 看一下] [更多選擇 ▾]
                                                              └▶ mirror in T's topic (same ticket, same buttons)
admin clicks 🔍 ─▶ fleet admits a system task to General (outbox, idle-gated) ─▶ General calls inspect_stuck_instance(ticket)
               ─▶ General calls report_stuck_triage(ticket, …) ─▶ fleet edits the notice: diagnosis + matching buttons
admin clicks an action ─▶ restart/interrupt: a confirm step ─▶ the fleet runs it ─▶ notice edited with the outcome
recovery at any point ─▶ notice edited "✅ 已恢復，不用處理", buttons removed, ticket closed
```

- **Who may click:** a fleet admin of T's world (`isFleetAdmin`), for every button, 🔍 included, because it costs a
  General turn. Anyone else gets S12 (ephemeral where the platform allows).
- **"更多選擇" before diagnosis:** 🔄 重新啟動 / ⏳ 再等等 stay available without asking General (the old path, now
  secondary), behind a disclosure button on Discord and as a second keyboard row on Telegram.
- **Ticket lifetime:** a ticket stays open until recovery or an action. The 🔍 button expires after 30 min without a
  click (S11); the actions stay.

## 5. The evidence tool

General gets **no shell, no pane typing and no file reads** on T. It gets one MCP tool, served by the fleet, that
returns a bounded, redacted snapshot.

```
inspect_stuck_instance { ticket: string }            // only with an open ticket addressed to the caller
→ {
  instance, backend, backend_version, display_name,
  signal: "frozen" | "lane_held", since, unchanged_for_s,
  state: { instance_state, working: [{ at, state, reason }] /* last 8 journal rows */ },
  screens: [ "auth" | "rate_limit" | "dialog:<key>" | "agent_list:<n>" | "editor_pager" | "queued" | "composer_draft"
             | "spinner" | "unknown" ],                                    // the backend's own matchers, as named
  pane: { rows: string[] /* ≤ 60, bottom-anchored */, ghost_marked: true, captured_at },
  lane: { head?: { delivery_id, kind, state, age_s, attempt_no, last_error },
          queued: number, paste_queue_depth: number,
          waiting_for?: "idle" | "handoff" | "dialog" | "spawn" },
  logs: { daemon: string[] /* ≤ 40 lines, this instance's, last 30 min */, output_tail: string[] /* ≤ 40 rows */ },
  hints: string[]                                     // fleet-computed facts, e.g. "box unreadable", "3 background agents"
}
```

- **Capture:** `capture-pane -p -e` once. SGR-2 (dim) runs are rewritten as `⟦ghost: …⟧`, so a prompt suggestion is
  never read as typing. The rest is stripped to text.
- **Redaction:** the existing `sanitizePaneTail` rules, plus token shapes (`sk-…`, `ghp_…`, `Bearer …`, `xox…`, JWTs,
  URL userinfo, query strings with `token|key|secret|code`). Also redacted: the message text of human deliveries and
  receipts (only kind, age and state are shown) and Discord/Telegram user ids.
- **Bound:** 16 KB of JSON at most. Rows are cut from the top, log lines from the oldest.
- **Gate:** the ticket must be open, addressed to this caller (T's world's General), and the call made within the
  ticket's 15-min inspection window. At most 3 calls per ticket. Anything else gets a refusal naming the reason.
- **No side effects:** it reads the daemon's state over IPC (no fork on the fleet loop).
  The single capture-pane runs in the daemon.

```
report_stuck_triage { ticket, where: string ≤ 200, why: string ≤ 400,
                      recommend: "wait" | "restart" | "interrupt" | "dev_fix", detail?: string ≤ 600 }
```

The fleet renders the result (S4). General's free text fills only the 「卡在哪」/「原因」 lines. Buttons, order and
wording come from the fleet. The recommended action goes first and is marked; the other actions follow in fixed order.
Without a report within 15 min, the notice is edited to S10 with the plain buttons.

**The task General receives:** a system notice through the delivery outbox: idle-gated, never steered into a turn,
silent to the user. The text: `[system:stuck-triage] ticket=<id> target=<T> signal=<…>. Call
inspect_stuck_instance, then report_stuck_triage. Read-only: do not message <T>, do not restart anything.`

## 6. Placement and relations

- **General (primary).** The notice is posted where General's admin prompts go: Discord General channel, the Telegram
  General topic, or `webOnlyPromptPlace()` for a web-only fleet.
- **T's topic (mirror).** It replaces today's hang prompt there: same ticket, same buttons; the first click wins and
  both copies are edited. The old hang prompt (S0) is no longer posted on its own.
- **Needs you.** The ticket is the item (reason `hang` → 「可能卡住」, or `lane_held` → 「訊息送不進去」), linking to the
  General notice:
  - on recovery the item leaves, and when the list then empties it reads S9 instead of today's plain empty line;
  - an action taken resolves it like any prompt.
- **Web.** The dashboard's Needs-you row shows the same text and buttons (🔍 included). The diagnosis appears in the
  row once reported.
- **Telegram.** Inline keyboard; callback data is `st:<nonce>:<action>` (fits 64 bytes). No ephemeral replies, so
  refusals to non-admins are a short reply that deletes itself after 30 s.

## 7. Strings (EN / zh-TW)

| id | EN | zh-TW |
|---|---|---|
| S0 (today's hang prompt, kept for `enabled: false`) | ⚠️ {name} may be stuck — pane unchanged for {n}min, ready prompt not recognized | ⚠️ {name} 可能卡住了 — 畫面已 {n} 分鐘無變化，也偵測不到就緒提示 |
| S1 notice (frozen) | ⚠️ {name} may be stuck: its screen hasn't changed for {n} min while it still has work. Want General to take a look first? | ⚠️ {name} 好像卡住了：畫面 {n} 分鐘沒動，可是它還有事沒做完。要先請 General 看一下嗎？ |
| S1b notice (lane held) | ⚠️ Messages to {name} haven't gone through for {n} min. Want General to take a look first? | ⚠️ 傳給 {name} 的訊息已經 {n} 分鐘送不進去。要先請 General 看一下嗎？ |
| B-look | 🔍 Ask General to check | 🔍 請 General 看一下 |
| B-more | More options | 更多選擇 |
| B-wait | ⏳ Wait a bit | ⏳ 再等等 |
| B-restart | 🔄 Restart it | 🔄 重新啟動 |
| B-interrupt | ⏹ Stop its current work | ⏹ 中斷目前工作 |
| B-devfix | 🛠 Needs a developer | 🛠 需要開發修 |
| S2 looking | 🔍 General is checking {name}… (read-only, nothing is changed) | 🔍 General 正在看 {name}…（只看不動，不會改任何東西） |
| S4 diagnosis | 🔍 General checked {name}.\nWhere: {where}\nWhy: {why}\nSuggested: {action} | 🔍 General 看過 {name} 了。\n卡在哪：{where}\n原因：{why}\n建議：{action} |
| S4 mark | (suggested) | （建議） |
| S5 confirm restart | Restart {name}? Its current work and any messages still waiting for it will be lost. | 確定要重新啟動 {name}？它手上的工作和還在排隊的訊息都會中斷。 |
| S5b confirm interrupt | Stop {name}'s current work? Like pressing Esc: the agent stays up, its current turn stops. | 確定要中斷 {name} 目前的工作？效果像按 Esc：agent 還在，只是停下手上這一輪。 |
| B-yes / B-no | Yes / Cancel | 確定 / 取消 |
| S6 waiting | ⏳ OK, waiting. I'll update this if {name} recovers, and ask again in {m} min if it doesn't. | ⏳ 好，先等等。{name} 恢復了這則會自動更新；{m} 分鐘後還沒好會再問你。 |
| S7 restarted / interrupted | 🔄 {name} restarted. / ⏹ {name}'s current work was stopped. | 🔄 {name} 已重新啟動。／⏹ 已中斷 {name} 目前的工作。 |
| S7b devfix | 🛠 Here is an issue draft with what General found. Copy it to GitHub, or ask an agent to file it. | 🛠 這是根據 General 查到的內容寫好的 issue 草稿，可以貼到 GitHub，或請 agent 幫你開。 |
| S8 recovered | ✅ {name} recovered by itself, nothing to do. | ✅ {name} 已恢復，不用處理。 |
| S9 list cleared itself | ✅ Nothing needs you right now (the earlier alert cleared by itself). | ✅ 目前沒有要你處理的事（剛才的提醒已自動解除）。 |
| S10 no report | General couldn't finish checking {name}. You can still pick an action below. | General 沒能查完 {name}，你還是可以直接選下面的動作。 |
| S11 look expired | The check offer expired. Pick an action below if {name} is still stuck. | 查看的選項已過期；如果 {name} 還卡著，請直接選下面的動作。 |
| S12 not admin | Only a fleet admin can do this. | 只有 fleet 管理員可以按這個。 |
| S13 General busy | ⚠️ {name} may be stuck, and General can't check right now ({reason}). Pick an action below. | ⚠️ {name} 好像卡住了，可是 General 現在也沒辦法查看（{reason}）。請直接選下面的動作。 |
| Needs-you reasons | May be stuck / Messages not getting through | 可能卡住／訊息送不進去 |

Interrupt uses today's cancel. Because cancel also drops messages queued in the daemon (#2770 (i)), the button is
offered only once #2770 (i) keeps queued messages across an interrupt. Until then it is hidden.

## 8. When General can't look

The 🔍 button is replaced by S13 with ⏳ / 🔄 (the old path) when:

- T *is* General;
- General is paused, stopped, crashed, or itself has an open ticket;
- General's own delivery lane is held;
- no General exists in T's world;
- the fleet-wide triage budget (§9) is spent.

`{reason}` is one of 「它自己也卡住了」/「它已暫停」/「它正在處理別的事」/「已到這小時的上限」.

## 9. Cost and rate limits

- One General turn per click. The task is ~400 tokens plus a snapshot of at most 16 KB, roughly 5–8k input tokens
  for a claude General.
- One open ticket per target. After a ticket closes, no new ticket for the same target and signal for 30 min (it
  reopens as a fresh episode after that).
- Fleet-wide: at most 3 triage turns per hour (`stuck_triage.max_per_hour`). Past that, S13 with 「已到這小時的上限」.
- The snapshot capture runs only on General's tool call, never on the alarm itself.
- Config: `stuck_triage.enabled` (default true), `lane_minutes` (10), `max_per_hour` (3). With
  `enabled: false`, the old hang prompt (S0) is posted unchanged.

## 10. Out of scope / follow-ups

- General taking actions itself (it only recommends; a person clicks).
- Auto-filing GitHub issues from 🛠 (a draft only).
- #2770 (i): the idle wait re-checks hand-off and honours Cancel. Required before ⏹ ships (§7).
- Classic channels: same notice in the channel's owner General; no mirror (no instance topic).

## 11. Tests (when built)

- §3 rules from real fixtures:
  - the 2026-10-27 replayed frames (agent list, three agents, ghost text);
  - an m365 start-up blip;
  - auth, dialog and rate-limit panes.
- Lane-held trigger from a recorded outbox shape (the head row `delivering` with no attempt row).
- Tool gate: no ticket, wrong caller, expired window and 4th call are refused.
- Redaction corpus. 16 KB bound.
- Buttons: admin-only, nonce consumed once across the General and topic copies, confirm step, recovery edits both.
- Telegram callback length; web Needs-you rendering.
