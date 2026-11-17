# Sharing agents by ticking them on the Hub page (M-3263)

Status: spec for the owner's approval. Nothing is built. It implements decision 2101c5b2 (owner, 2026-11-17).
"Today" means a source survey of the development branch at `297475387`; nothing was run.

## 0. What changes

Today, sharing an agent takes two places: the switch in the Fleet's Settings → Hub, a confirmation card in the
Fleet's General, and then the Hub page to choose who may ask. The Hub page only lists what is already shared.

After this: the Hub page lists **every agent in your connected Fleets**. You tick the ones to share, press
**Share N agents**, and choose who may ask. The Fleet applies it without a second confirmation and posts a notice
in its General with **Undo**.

## 1. Today

| | Today |
|---|---|
| Hub page "My shared agents" / 「我分享的 Agent」 | A flat list of shared agents, with "who may ask", pause and stop. Read-only for starting a share: "To share or stop sharing one, use your fleet's Settings → Hub." |
| What the Hub knows about unshared agents | **Nothing.** The Fleet tells the Hub only about shared agents, and sends no avatar or description at all |
| Starting a share | Fleet Settings → Hub → switch → a held change that a Fleet administrator confirms in General or on the web |
| Stopping a share | Fleet Settings → Hub → switch off. Immediate, no confirmation. Clears who may ask |
| Hub → Fleet requests | Only a version update (when the owner allowed it) and a move to a new address. **The Hub cannot ask a Fleet to share anything** |
| Does the Fleet know its owner? | Yes: the company person who connected it is stored with the connection |
| "My fleets" | A card with "{0} of {1}" and "+ Connect another fleet" |
| Limits | 64 shared agents per Fleet. ClassicBot rooms cannot be shared. A Windows one-shot agent can be shared but cannot answer |
| Contact limit (M-3160) | Built; on by default for every share |

## 2. The page

Name: **My agents** / 「我的 Agent」 (today "My shared agents"; it now lists unshared agents too. See S1).

### 2.1 Layout

```
My agents
The agents you can share on this Hub, and who may ask each one.

My fleets · 2 of 8                                                    + Connect another fleet

▾ Work laptop   · Connected                                              3 of 5 shared
  ☑  [av]  Release helper     Answers questions about the release plan.     Shared · 12 people may ask   ›
  ☑  [av]  Docs               Knows the product documents.                  Shared · nobody may ask yet  ›
  ☐  [av]  Scratch            (no description)
  ☐  [av]  Build watcher      Watches the nightly build.
  ☐  [av]  General            Your Fleet's General. It can manage this Fleet.
  ▫  [av]  Support room       ClassicBot rooms can't be shared yet.

▾ Home server   · Offline since 14:02                                     1 of 4 shared
  ▣  [av]  Notes              …                                             Shared · 3 people may ask    ›
  ▫  [av]  Tests              This Fleet is offline. Shown as last seen at 14:02.

▾ On my own computer
  Personal agent "Notes"      Ready · 2 people may ask                                                   ›

──────────────────────────────────────────────────────────────────────────────────────────────
 Share 2 agents                                                          [ Share 2 agents ]  Cancel
```

- **Grouped by Fleet**, each group collapsible, with its state and "n of m shared". The existing "My fleets"
  count and "+ Connect another fleet" sit above the groups.
- **A row**: checkbox, avatar, name, one-line description, then for a shared agent its state and a summary of who
  may ask. A shared row opens the existing agent page (who may ask, pause, activity).
- **A ticked box means shared.** Ticking an unshared agent, or unticking a shared one, is a pending change; nothing
  happens until the bar is pressed.
- **The bar** appears at the bottom of the page as soon as there is a pending change, and stays in view while
  scrolling (the pattern Google's admin lists use for bulk actions).
- **Personal agents** appear in their own group with their state and a link to their card. They are shared by
  their own steps (M-3262), not by this bar.
- **General** is listed last in its Fleet, with a plain warning in place of a description, and "Select all" in a
  group does not tick it.
- Phone: one column; the description wraps under the name; the bar is a full-width button fixed above the
  bottom edge.

### 2.2 The bar

| Pending changes | Bar text | Button |
|---|---|---|
| Only new shares | Share {n} agents | **Share {n} agents** |
| Only stops | Stop sharing {n} agents | **Stop sharing {n} agents** (danger) → confirm |
| Both | Share {n} · Stop sharing {m} | **Apply changes** → confirm for the stops |

| | EN | zh-TW |
|---|---|---|
| Bar | Share {n} agents / Stop sharing {n} agents / Share {n} · Stop sharing {m} | 分享 {n} 個 Agent / 停止分享 {n} 個 Agent / 分享 {n} 個 · 停止分享 {m} 個 |
| Buttons | Share {n} agents · Stop sharing {n} agents · Apply changes · Cancel | 分享 {n} 個 Agent · 停止分享 {n} 個 Agent · 套用變更 · 取消 |
| Group count | {n} of {m} shared | 已分享 {n} / {m} |
| Group action | Select all | 全選 |

### 2.3 While it is applied

Each affected row shows "Sharing…" / 「分享中…」 or "Stopping…" / 「停止中…」 until its Fleet answers.

| Result | EN | zh-TW |
|---|---|---|
| Done | Shared | 分享中 (the existing tag) |
| Fleet did not answer in 30 seconds | Not shared: this Fleet didn't answer. Try again. | 沒有分享：這個 Fleet 沒有回應，請再試一次。 |
| Fleet refused | Not shared: {reason from 2.6} | 沒有分享：{原因} |
| The list changed meanwhile | This list changed. It has been refreshed; tick again. | 清單已有變動並重新整理，請重新勾選。 |

Rows that succeeded stay done; a failure on one does not undo the others.

### 2.4 Straight on to "who may ask"

A newly shared agent can be asked by nobody. So the moment sharing succeeds, the page moves to that step:

- **One agent**: the existing picker opens for it ("Allow access to {0}" / 「允許向 {0} 提問」).
- **Several agents**: one screen listing them, with a choice:

| | EN | zh-TW |
|---|---|---|
| Title | {n} agents are shared. Who may ask them? | 已分享 {n} 個 Agent。誰可以問它們？ |
| Lead | Nobody can ask them until you choose. | 在你選擇之前，沒有人可以問它們。 |
| Choice 1 | The same people for all {n} | {n} 個都用同一份名單 |
| Choice 2 | Choose for each agent | 每個 Agent 分開選 |
| Skip | Decide later | 稍後再決定 |

"Decide later" leaves them shared with the summary "nobody may ask yet" / 「還沒有人可以問」 on each row.

### 2.5 Stopping

| | EN | zh-TW |
|---|---|---|
| Title | Stop sharing {n} agents? | 要停止分享 {n} 個 Agent 嗎？ |
| Body | People will no longer be able to ask: {names}. Their lists of who may ask are cleared. | 同仁將無法再問：{names}。這些 Agent 的「可以提問的人」名單會被清除。 |
| Hint | To keep the lists and only stop answers for now, pause sharing instead. | 如果只是暫時不回答、想保留名單，請改用「暫停分享」。 |
| Buttons | Stop sharing · Pause instead · Cancel | 停止分享 · 改為暫停 · 取消 |

One confirmation for the whole batch. "Pause instead" uses the existing pause, which is Hub-side and needs
nothing from the Fleet.

### 2.6 Rows that cannot be ticked, and why

The checkbox is greyed and the reason replaces the description.

| Case | EN | zh-TW |
|---|---|---|
| Fleet offline | This Fleet is offline. Shown as last seen at {time}. | 這個 Fleet 目前離線，顯示的是 {time} 的狀態。 |
| Administrator has not allowed sharing (banner above the groups; every unshared row greyed) | Your Hub administrator hasn't allowed you to share agents. | Hub 管理員還沒有允許你分享 Agent。 |
| ClassicBot room | ClassicBot rooms can't be shared yet. | ClassicBot 房間還不能分享。 |
| Windows one-shot agent | This kind of agent can't answer Hub questions yet. | 這種 Agent 還不能回答 Hub 的提問。 |
| Fleet too old (one line for the group, section 5) | Update this Fleet to share agents from here. | 請更新這個 Fleet，才能從這裡分享 Agent。 |
| Turned off in the Fleet (3.5) | Sharing from the Hub page is turned off in this Fleet's Settings → Hub. | 這個 Fleet 的「設定 → Hub」關閉了從 Hub 頁面分享。 |
| 64 already shared | This Fleet already shares 64 agents, the most allowed. | 這個 Fleet 已經分享 64 個 Agent，達到上限。 |
| Fleet paused or revoked | This Fleet is paused on this Hub. / This Fleet was removed from this Hub. | 這個 Fleet 在這個 Hub 已暫停。/ 這個 Fleet 已從這個 Hub 移除。 |

A shared agent whose Fleet is offline keeps its tick, greyed (▣ above): it cannot be stopped from here until the
Fleet returns, but it can be paused.

### 2.7 A colleague with no Fleet and no personal agent

They can only use the Hub's pages. "My agents" must not be an empty list or a bare "not enabled". It shows:

```
You don't have an agent on this Hub yet.

You can already ask other people's agents: open Chats, or @mention an agent in a room.

To have an agent of your own that colleagues can ask:

  1. A personal agent on your Windows computer        [ Set up a personal agent ]
     Your own Codex or Claude Code answers. No Fleet needed.
  2. Connect a Fleet                                   [ Connect a Fleet ]
     If you run AgEnD, share the agents in it.

Your own Claude Code or Codex can also use this Hub for you  ·  My AI apps ›
That is for asking and posting as you. Colleagues can't ask it.
```

| | EN | zh-TW |
|---|---|---|
| Title | You don't have an agent on this Hub yet. | 你在這個 Hub 還沒有自己的 Agent。 |
| Already | You can already ask other people's agents: open Chats, or @mention an agent in a room. | 你現在就可以問別人的 Agent：到「對話」，或在房間裡 @ 一個 Agent。 |
| Lead | To have an agent of your own that colleagues can ask: | 想要有自己的 Agent 讓同仁提問： |
| Option 1 | A personal agent on your Windows computer · Your own Codex or Claude Code answers. No Fleet needed. · Set up a personal agent | 在你的 Windows 電腦上架一個個人 Agent · 由你自己的 Codex 或 Claude Code 回答，不需要 Fleet。· 設定個人 Agent |
| Option 1, switched off | Personal agents are turned off on this Hub. Ask your Hub administrator. | 這個 Hub 還沒有開啟個人 Agent，請洽 Hub 管理員。 |
| Option 1, not allowed | Ask the Hub administrator to let you add a personal agent. | 請 Hub 管理員允許你新增個人 Agent。 |
| Option 2 | Connect a Fleet · If you run AgEnD, share the agents in it. · Connect a Fleet | 連接 Fleet · 如果你有在使用 AgEnD，可以分享裡面的 Agent。· 連接 Fleet |
| Apps | Your own Claude Code or Codex can also use this Hub for you. That is for asking and posting as you. Colleagues can't ask it. · My AI apps | 你自己的 Claude Code 或 Codex 也可以替你使用這個 Hub，用來提問和發言；同仁不能問它。· 我的 AI App |

Each option shows only when it is possible for that person; an option the administrator has not allowed shows
its reason line and no button.

## 3. What the Fleet does

### 3.1 How the Fleet knows the request is its owner's

- The Hub accepts the request only from a **signed-in browser session** of the person who connected that Fleet.
  A connected AI app (My AI apps) can never do it, and neither can a Hub administrator for someone else's Fleet.
- The Hub sends the Fleet a request naming that person, over the Fleet's own authenticated, pinned connection.
- The Fleet compares the named person with the owner it stored when it was connected. A request naming anyone
  else is refused and recorded.
- **What the Fleet cannot check**: that the person really pressed the button. It trusts the Hub's statement. See
  section 6.

### 3.2 Applying it

The Fleet applies a share exactly as a confirmed share from Settings → Hub: the same record, the contact limit
on, the agent's existing name and description. It then tells the Hub with its usual list of shared agents, which
is what the Hub page shows. No confirmation card appears.

### 3.3 The General notice, with Undo

One notice per request, in the Fleet's General (Discord or Telegram), and in Notices on the web. A web-only Fleet
gets the web notice only.

| | EN | zh-TW |
|---|---|---|
| Shared, one | 🔗 {owner} shared **{agent}** with {hub} from the Hub page. Nobody can ask it until {owner} chooses who may ask. | 🔗 {owner} 從 Hub 頁面把 **{agent}** 分享到 {hub}。在 {owner} 選擇誰可以問之前，沒有人可以問它。 |
| Shared, several | 🔗 {owner} shared {n} agents with {hub} from the Hub page: {names}. | 🔗 {owner} 從 Hub 頁面把 {n} 個 Agent 分享到 {hub}：{names}。 |
| Stopped | 🔗 {owner} stopped sharing {names} with {hub} from the Hub page. | 🔗 {owner} 從 Hub 頁面停止把 {names} 分享到 {hub}。 |
| Button | Undo | 復原 |
| After Undo | Undone by {admin}. {names}: no longer shared. / shared again. | {admin} 已復原。{names}：不再分享。/ 已重新分享。 |
| Too late | This can no longer be undone here. Use Settings → Hub. | 已經無法在這裡復原，請到「設定 → Hub」。 |

### 3.4 What Undo does

- **Who**: a Fleet administrator, as for other General buttons.
- **Until when**: 24 hours after the notice.
- **Undo a share**: the agent stops being shared. Anyone allowed to ask in the meantime loses that; questions
  already delivered are still answered.
- **Undo a stop**: the agent is shared again **with its earlier list of who may ask**. For that, the Hub keeps
  the list of a stopped agent for 24 hours before clearing it. (Today it is cleared at once.)
- Undo acts on the whole notice. To undo one agent of several, use the switches.
- If the agents' state has changed since (someone already switched one), Undo applies only to those still as the
  notice left them, and says which.

### 3.5 Staying in step with Settings → Hub

- The Fleet remains the one record of what is shared. The Hub page and the Settings → Hub switches both show it,
  so a change in one appears in the other within seconds.
- The switches in Settings → Hub keep working as today, with today's confirmation.
- One new switch there, **on by default**:

| | EN | zh-TW |
|---|---|---|
| Switch | Let me share agents from the Hub page | 允許我從 Hub 頁面分享 Agent |
| Hint | When on, this Fleet sends the Hub your agents' names and descriptions, which only you can see there, and applies a share or stop you make on the Hub page without asking again. A notice with Undo is posted here each time. | 開啟後，這個 Fleet 會把你的 Agent 名稱與說明傳給 Hub（在 Hub 上只有你看得到），並直接套用你在 Hub 頁面做的分享或停止，不再另外確認。每次都會在這裡發出可以復原的通知。 |

  Turning it off stops both the list (4) and Hub-page sharing for this Fleet; the Hub page then shows the reason
  in 2.6. This is the owner's way to keep today's behaviour.

## 4. The list of agents the Fleet sends

- **What**: for every agent in the Fleet, shared or not: its name, display name, avatar (the emoji and colour it
  already has), one-line description, kind, and whether it can be shared (with the reason if not). ClassicBot
  rooms are included as rows that cannot be shared.
- **Not sent**: folders, models, tool sets, schedules, conversation content, or anything about people.
- **Who sees it**: on the Hub, only the Fleet's owner. It is not in search, not in "ask an agent", not on the
  administrator's pages. A Hub administrator sees only shared agents, as today.
- **When it refreshes**:
  - when the Fleet connects;
  - when an agent is added, removed, renamed, or its description or avatar changes (sent within a few seconds);
  - when the owner opens "My agents" and the list is older than a minute, or presses **Refresh**.
- The page shows "Updated {time}" per Fleet. An offline Fleet shows its last list, greyed.
- Removing a Fleet from the Hub deletes its list.

## 5. Fleets that are too old

A Fleet that does not announce the two new abilities (the list, and Hub-page sharing):

- Its **shared** agents show as today, and "who may ask" and pause work as today.
- Its unshared agents are unknown, so instead of rows the group shows one line and one action:

| | EN | zh-TW |
|---|---|---|
| Line | Update this Fleet to share agents from here. Until then, use its Settings → Hub. | 請更新這個 Fleet，才能從這裡分享 Agent。在那之前，請使用它的「設定 → Hub」。 |
| Tag | Needs update (the existing tag) | 需要更新 |
| Action | Update this Fleet | 更新這個 Fleet |

- Shared rows keep their tick but it is greyed: stopping needs the Fleet, so the row says "Stop sharing in this
  Fleet's Settings → Hub." / 「請到這個 Fleet 的「設定 → Hub」停止分享。」
- "Update this Fleet" opens the existing update guidance for the owner.

## 6. What this costs

- **The Hub can now make a Fleet share an agent.** Today it cannot: every share is confirmed on the Fleet. After
  this, a Fleet with the switch on trusts the Hub's word that its owner asked. So whoever controls the Hub, or
  the owner's Hub sign-in (their company password), can share any agent in that owner's Fleets and then choose who
  may ask. A shared agent answers with its normal tools.
- **What stands in the way**: the notice with Undo in the Fleet's own General, which the Hub cannot suppress; the
  contact limit, on by default; the owner's switch to turn the whole thing off; and that only a browser sign-in
  can do it, never an app token.
- **The names and descriptions of all your agents are stored on the company Hub**, shared or not. Only you see
  them in the Hub's pages; whoever runs the Hub's computer can read its data.
- **No second confirmation means no second look.** A mis-tick shares at once. The agent cannot be asked until
  "who may ask" is chosen, which is the remaining pause.
- **Undo on a stop needs the Hub to keep a stopped agent's list for 24 hours.** Until then "stopped" does not
  mean "forgotten".

## 7. Seams for the build

Kept to three, plus two abilities announced when the Fleet connects.

| Seam | What |
|---|---|
| Abilities | `agent-catalog-v1` (the Fleet sends its list) and `exposure-request-v1` (the Fleet accepts Hub-page sharing). The Hub checks both per Fleet; without them, section 5 |
| Fleet → Hub: `agent.catalog` | `{revision, agents: [{instance, displayName, avatar, description, kind, shareable, reason?}]}`. Complete each time, at most the Fleet's agents plus ClassicBot rooms. Stored per Fleet, owner-only |
| Hub API | `GET /hub/v1/me/agents`: groups, rows, states, reasons, the publish permission, list age. `POST /hub/v1/me/agents/sharing {fleetId, catalogRevision, share: [instance], stop: [exposureId]}` → `{requestId}`; browser session of the Fleet's owner only. `GET /hub/v1/me/agents/sharing/:requestId` for per-row results. `POST /hub/v1/me/agents/refresh {fleetId}` |
| Hub → Fleet: `exposure.request` | `{requestId, by: person, catalogRevision, share: [instance], stop: [exposureId]}` |
| Fleet → Hub: `exposure.request-result` | `{requestId, results: [{instance | exposureId, ok, code?}]}`, followed by the usual complete list of shared agents |
| Fleet handler | Check the switch, the ability, that `by` is the stored owner, and the list revision; apply through the existing share writer with the source marked "from the Hub page"; post the notice with Undo; answer. Undo goes through the same writer |
| Hub, on stop | Keep a stopped agent's "who may ask" for 24 hours, restore it if the same agent is shared again in that time |
| Records | The request, who made it and each result are recorded as actions on the Hub; the Fleet records the request and any Undo |

Refusal codes for a row: `not-owner`, `switched-off`, `stale-list`, `not-shareable`, `limit`, `not-allowed`,
`unknown-agent`.

## 8. Questions for the owner

| # | Question | Recommendation |
|---|---|---|
| S1 | Rename the page to "My agents" / 「我的 Agent」? | **Yes.** It now lists agents that are not shared. |
| S2 | The Fleet switch "Let me share agents from the Hub page": on or off by default? | **On**, as the decision intends, including for Fleets already connected once they update. The first time it applies anything, the notice says so. |
| S3 | Undo window | **24 hours.** |
| S4 | General in the list | **Listed, never ticked by "Select all", with a plain warning.** |
| S5 | Should Settings → Hub also drop its confirmation when the owner flips a switch there? | **Not in this change.** Keep today's behaviour there; decide after this ships. |
| S6 | Keep a stopped agent's list for 24 hours so Undo can restore it? | **Yes.** Otherwise Undo of a stop gives back an agent nobody can ask. |

## 9. 給擁有者的摘要（zh-TW）

1. 「我分享的 Agent」改名為「我的 Agent」，依 Fleet 分組列出你所有的 Agent（不只已分享的），每一列有勾選框、頭像、名稱與說明。
2. 勾選後按下方的「分享 N 個 Agent」就完成，不用再到 Fleet 的設定，也不用在 Fleet 再確認一次。
3. 分享成功後直接進入「誰可以問」：在你選擇之前，沒有人可以問它們。可以一份名單套用全部，也可以分開選。
4. 取消勾選是停止分享，整批只確認一次，並提供「改為暫停」保留名單。
5. Fleet 會在自己的 General 發通知「某人從 Hub 頁面分享了 X」，附「復原」按鈕，24 小時內有效；復原停止分享時會把原本的名單一起還原。
6. 不能勾的列會寫原因：Fleet 離線、管理員還沒允許分享、ClassicBot 還不能分享、Fleet 版本太舊（顯示「更新這個 Fleet」）。
7. Fleet 的「設定 → Hub」開關保留，兩邊同步；另外多一個預設開啟的開關「允許我從 Hub 頁面分享 Agent」，關掉就回到現在的做法。
8. 還沒有 Fleet、也沒有個人 Agent 的同仁，會看到清楚的說明：現在就能問別人的 Agent；想有自己的 Agent，可以在 Windows 架個人 Agent，或連接 Fleet；自己的 Claude Code／Codex 也能連到 Hub，但那是用來提問，別人不能問它。
9. 要知道的代價：以前 Hub 沒辦法讓 Fleet 分享任何東西；現在只要是你的公司帳號在 Hub 上操作，Fleet 就會照做。所以有通知與復原、預設開啟的「不能聯絡其他 Agent」限制，以及可以整個關掉的開關。你所有 Agent 的名稱與說明也會存在公司的 Hub 上（頁面上只有你看得到）。
