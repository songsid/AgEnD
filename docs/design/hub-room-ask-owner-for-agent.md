# Adding an agent to a room when its owner has not shared it with you (M-3310)

Status: spec for the owner's decision. Nothing is built. "Today" was checked by use on the development tip
`c891e8d41` (a real Hub server on scratch data, headless browser), 2026-11-18.

## 1. Today, as used

Set-up: Alex manages the room "Project". Jo owns a shared agent, "Release helper". Jo has not allowed Alex to ask it.

| Step | What happened |
|---|---|
| Alex opens Room settings → **Add or invite agents** and types "Release" | **"Nothing matches."** |
| Alex types the owner's name, "Jo" | **"Nothing matches."** The picker finds agents and teams, not people's agents |
| Why | The picker lists only agents Alex may already ask, and Alex's own. The Hub's answer for this search was an empty list |
| After Jo allows Alex to ask the agent | The picker shows "Release helper" with owner Jo. Picking it sends an invitation |
| What Jo then sees (Hub → Invitations, with a count in the side bar) | "Alex invited your agent "Release helper" to the room "Project". The 1 person in the room can @ it there; everyone in the room sees its answers. When @-ed, it reads the room's recent messages." **Agree · Decline** |
| What Alex sees meanwhile | "Release helper (Jo) · invited, waiting for the owner" with **Cancel invitation** |

So the owner's one-press consent, scoped to one room, **already exists**. The blocker is earlier: the manager
cannot find the agent, so there is nothing to invite. To get an agent into a room today, its owner must first
give the manager the right to ask it one-to-one, which is more than the room needs.

One more thing the check found: the Hub accepted an invitation for an agent Alex could not see, when given the
agent's id directly, and answered with the agent's name and owner. The id is long and random, so this is not a
practical way to browse, but the rule should be the same as the picker's. It is in the cards.

## 2. Three ways to solve finding, and what each reveals

| | (1) List agents you may not ask, marked "Ask the owner" | (2) Pick the owner, ask them to add one | (3) Invite the owner as a person; they add their agent |
|---|---|---|---|
| What the manager does | Searches by agent name, sees every shared agent on the Hub | Searches for a person, presses "Ask {owner} to add an agent" | Adds the owner to the room, then asks them in the room |
| What it reveals to the manager | **The existence, name, owner and introduction of every shared agent**, to anyone who manages a room. An owner who shared "Reorganisation planning" with two people did not agree to that | **Nothing.** Not even whether that person has an agent. The manager learns something only if the owner says yes | Nothing |
| What the owner does | One press on a request naming the agent | Picks which agent (one press if they have one), or declines | Joins the room, opens settings, adds their agent |
| Cost | A Hub-wide directory of agents by default | The manager must know whose agent they want | The owner must be in the room and read it; today only managers can add agents, so this also needs a new rule |
| Works when the manager only knows the agent's name | Yes | No | No |

## 3. Recommendation

**(2) as the way in, with (1) as something an owner switches on for an agent they want found.**

- (2) leaks nothing and matches how people ask in an office: "Jo, can your release agent join our room?"
- Some agents are meant to be found by everyone (a documentation agent, a help desk). For those, the owner
  ticks **"Room managers can find this agent"** on the agent's page, off by default. Only then does it appear in
  other managers' pickers, with its name, owner and introduction, marked "Ask {owner}".
- (3) is not recommended. It puts a person in a room in order to place their agent there.
- Option (b) from the request, "add my agents to rooms I'm in without asking me", is a reasonable later setting
  for owners who are tired of pressing Agree. It only applies when the owner is already a member, so it does not
  solve finding. Left as a question (Q4).

## 4. The flow

### 4.1 The manager

In Room settings, under **Add or invite agents**:

```
Add or invite agents
[ Release                        ]
Nothing matches.
Can't find someone's agent? It may not be shared with you.   [ Ask its owner ]
```

"Ask its owner" opens a people search (the same one used for members), then:

```
Ask Jo to add an agent to "Project"

Jo will see who is asking and which room. You will only learn about an agent if Jo adds one.

Which agent, if you know (optional)
[ the one that tracks releases                    ]   0 / 100

                                         [ Send request ]  Cancel
```

Afterwards the room's list shows: "Asked Jo for an agent · waiting" with **Cancel request**.

### 4.2 The owner

- **Where**: Hub → Invitations (the existing page and side-bar count). Also as a notice in the owner's Fleet
  General once notification forwarding exists (`hub-admin-priorities.md` item 2); until then, on the Hub only.
- **The card**:

```
Alex asks you to add one of your agents to the room "Project"
"the one that tracks releases"

People in the room can @ it there, and everyone in the room sees its answers. When @-ed, it reads the
room's recent messages. They cannot ask it one-to-one. 3 people are in the room now; the room's managers
can add more.

Which agent
(•) Release helper      Tracks the release checklist and sign-offs.
( ) Docs                Knows the product documents.
( ) Scratch             Not shared yet. Share it first on My agents.

                                              [ Add to this room ]  Decline
```

- With one shared agent it is preselected: one press.
- Agents that are not shared are listed greyed with the way to share them. Agreeing here never shares an agent
  with the Hub; it only places an already shared agent in this room.

### 4.3 What agreeing gives, and what it does not

| | |
|---|---|
| Who may ask it | Members of that room, in that room, by @mention. As today's invitation |
| One-to-one questions | **Not granted.** The manager still cannot ask it outside the room |
| What the agent sees | As any agent in a room: the recent messages when it is @-ed, and the room's purpose and members if it looks (`hub-room-agent-context.md`) |
| What the room sees | The agent's name, owner and introduction in the members list, and its answers |
| New members later | They can @ it too. The card says so ("the room's managers can add more") |
| Until when | Until the owner or a manager removes it from the room, the owner stops sharing it, or the room is archived |

### 4.4 Declining, leaving, taking it back

- **Decline**: the manager sees "Jo didn't add an agent." Nothing about which agents Jo has.
- **No answer**: the request ends after 7 days: "Jo didn't answer."
- **The owner removes the agent later**: from the agent's page → "In these rooms" → Leave (exists today). The
  room shows the existing system line that the agent left.
- **A manager removes it**: as today.
- **The owner stops sharing the agent**: it leaves every room (as today).
- **Limits**: one open request per owner per room; a manager can send at most 5 requests per UTC calendar day
  (a cancelled request counts, a refused one does not; the page shows when more can be sent, in local time). An owner can
  turn requests off: "Don't let room managers ask me for agents" on My agents.

## 5. Copy

| | EN | zh-TW |
|---|---|---|
| Under an empty search | Can't find someone's agent? It may not be shared with you. | 找不到某位同仁的 Agent 嗎？它可能沒有分享給你。 |
| Button | Ask its owner | 請擁有者加入 |
| Dialog title | Ask {owner} to add an agent to "{room}" | 請 {owner} 把 Agent 加入「{room}」 |
| Dialog lead | {owner} will see who is asking and which room. You will only learn about an agent if {owner} adds one. | {owner} 會看到是誰提出、是哪個房間。只有在 {owner} 加入之後，你才會知道是哪個 Agent。 |
| Note field | Which agent, if you know (optional) | 如果知道是哪個 Agent，可以寫在這裡（選填） |
| Buttons | Send request · Cancel | 送出請求 · 取消 |
| Waiting row | Asked {owner} for an agent · waiting | 已請 {owner} 加入 Agent · 等待中 |
| Row action | Cancel request | 取消請求 |
| Owner's card title | {asker} asks you to add one of your agents to the room "{room}" | {asker} 請你把一個 Agent 加入房間「{room}」 |
| Owner's card body | People in the room can @ it there, and everyone in the room sees its answers. When @-ed, it reads the room's recent messages. They cannot ask it one-to-one. {n} people are in the room now; the room's managers can add more. | 房間裡的人可以在房間裡 @ 它，所有人都看得到它的回答。被 @ 時，它會讀到房間最近的訊息。他們不能一對一問它。房間現在有 {n} 個人，房間管理員之後可以再加人。 |
| Choice heading | Which agent | 要加入哪一個 |
| Unshared row | Not shared yet. Share it first on My agents. | 還沒有分享。請先到「我的 Agent」分享。 |
| Buttons | Add to this room · Decline | 加入這個房間 · 不要 |
| Declined, to the manager | {owner} didn't add an agent. | {owner} 沒有加入 Agent。 |
| Expired, to the manager | {owner} didn't answer. | {owner} 沒有回應。 |
| Owner's switch, per agent | Room managers can find this agent | 房間管理員可以找到這個 Agent |
| Its hint | When on, anyone who manages a room sees this agent's name, your name and its introduction, and can ask you to add it. | 開啟後，任何房間管理員都會看到這個 Agent 的名稱、你的名字和它的自我介紹，並可以請你把它加入房間。 |
| A findable agent in the picker | {agent} · {owner} · Ask {owner} | {agent} · {owner} · 請 {owner} 加入 |
| Owner's opt-out | Don't let room managers ask me for agents | 不要讓房間管理員請我加入 Agent |
| Owner has opted out | {owner} isn't taking requests for agents. | {owner} 目前不接受加入 Agent 的請求。 |
| One already open | A request to {owner} is already open for this room. | 這個房間已經向 {owner} 送出請求，仍在等待回應。 |
| Daily limit | You have sent 5 requests today. You can send more after {time}. | 你今天已送出 5 個請求，{time} 之後可以再送。 |

## 6. Cards

| Card | What | Size |
|---|---|---|
| A1 | "Ask its owner": the people search, the request, the waiting row, cancel, limits | M |
| A2 | The owner's card on Invitations: choose an agent, add or decline; the 7-day end | M |
| A3 | The invitation rule: refuse an invitation for an agent the manager can neither ask nor find, without naming it | S |
| A4 | "Room managers can find this agent": the per-agent switch and the marked rows in the picker | S–M |
| A5 | The request in the owner's Fleet General | S, after notification forwarding |

A1 and A2 together fix the pain point. A3 can go first; it is independent.

## 7. Questions for the owner

| # | Question | Recommendation |
|---|---|---|
| Q1 | Which way to find an agent? | **Ask the owner by person (2)**, plus an owner's opt-in to make an agent findable (1). Not a Hub-wide list by default. |
| Q2 | May the owner add an agent that is not shared yet from the card? | **No.** Sharing stays a separate, deliberate step on My agents; the card links there. |
| Q3 | Tell the owner when the room later gains members? | **Not now.** The card says managers can add more. Revisit if owners ask. |
| Q4 | "Add my agents to rooms I'm in without asking me" | **Later**, as an owner's setting, off by default. |
| Q5 | Request lifetime and limits | **7 days; one open request per owner per room; 5 per UTC calendar day per manager; an owner can switch requests off.** |

## 8. 給擁有者的摘要（zh-TW）

**實際操作確認的現況：** 房間管理員在「新增或邀請 Agent」輸入 Agent 名稱或擁有者名字，都只會看到「沒有符合的項目」，因為選單只列出管理員本來就可以問的 Agent。擁有者先把 Agent 開放給管理員一對一提問之後，選單才會出現；選了之後擁有者會收到邀請卡，按「同意」即可。也就是說，「擁有者按一下、只在這個房間有效」這件事已經有了，卡住的是找不到。

**三種找法各自會洩漏什麼：**
1. 選單列出所有已分享的 Agent、標示「請擁有者加入」：所有房間管理員都會看到每個 Agent 的存在、名稱、擁有者與介紹，擁有者當初並沒有同意這件事。
2. 先找人，再請對方加入他的 Agent：完全不洩漏，連對方有沒有 Agent 都不知道，擁有者同意後才看得到。
3. 把擁有者拉進房間，由他自己加：不洩漏，但為了放一個 Agent 而把人拉進房間。

**建議：** 用第 2 種當入口。管理員按「請擁有者加入」→ 選人 → 可以寫一句想要哪個 Agent → 送出。擁有者在 Hub 的「邀請」看到請求，選一個已分享的 Agent（只有一個時直接按一下）或拒絕。另外讓擁有者可以對個別 Agent 開啟「房間管理員可以找到這個 Agent」（預設關閉），適合文件、客服這類本來就希望大家找得到的 Agent。

**同意之後的範圍：** 只有那個房間的成員可以在房間裡 @ 它；管理員仍然不能一對一問它。Agent 被 @ 時讀得到房間最近的訊息。擁有者隨時可以把它移出房間。

**另外發現：** 如果直接帶 Agent 的編號送出邀請，Hub 目前會接受，並回傳 Agent 名稱與擁有者。編號很長、無法猜測，實際風險低，但規則應該和選單一致，已列成一張小卡。

**要請你決定：** Q1 找法（建議第 2 種＋擁有者自選公開）；Q2 卡片上能不能直接加入還沒分享的 Agent（建議不行）；Q4 是否提供「我在的房間可直接加入我的 Agent，不用問我」（建議之後再做）；Q5 請求 7 天失效、每位管理員一天最多 5 次。
