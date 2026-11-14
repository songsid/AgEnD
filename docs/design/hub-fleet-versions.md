# Hub ↔ Fleet versions — M-3130

Status: accepted by the leader on 2026-11-15, V1–V5 as recommended. Source read: `release/2.3.5-alpha` (survey of 2026-11-15). Pilot rule: features and UX first;
no separate security review. What each step costs is stated in section 7 so it can be picked up before launch.

## 0. The problem and the three steps

Many people never press Update. Their Fleet stays connected to the Hub, but newer Hub features (rooms, agent posts)
do not work with it, and today nobody is told why. The only sign is a grey "Needs an AgEnD update" dot on an agent in
a room.

The user chose to plan three steps together:

1. **See.** The Hub administrator sees each connected Fleet's AgEnD version; old ones are flagged.
2. **Recommend.** The administrator sets a recommended version. A Fleet that is behind tells its owner, on the web and
   in chat, with a button that runs the Fleet's normal Update.
3. **Update for them.** A Fleet owner can opt in to let the Hub administrator update their Fleet. Only versions
   published on npm, no code from the Hub, only while agents are idle, the owner is told, and a failure rolls back.

Each step works without the next one. Step 1 alone already lets an administrator walk over to a colleague.

## 1. What exists today, and the gaps

| Need | Exists today | Gap |
|---|---|---|
| Hub knows a Fleet's version | No. The link's `hello` carries protocol version and capability names only; the Fleet record has no version field. | Fleet reports its version; Hub stores it. Note for the builder: the capability list is capped at 16 and 14 are used (15 once #3920 adds `room-post-v1`), so the version must travel as a value, not as more capability names. |
| Admin list of Fleets | Hub → Administration, card "Connected fleets · N": label, owner, Active/Revoked, Revoke. "Connected" means paired, not online. | Version, last-connected time and a state tag per row. |
| Skew signal | Per agent in a room: "Needs an AgEnD update" / 「需要更新 AgEnD」 when the Fleet lacks the room capabilities. | Same fact, shown once per Fleet where the administrator and the owner can act on it. |
| Fleet Update, web | Banner "AgEnD v{0} is available (current v{1})" with **Update now** / **Later**, a confirm, four progress steps, failure texts, **Reload**. Settings → Advanced → "Version and update". Admin web session only. | Reuse as is. Needs a second reason to appear ("your Hub recommends…") and a pinned target version. |
| Fleet Update, chat | `/update` (Fleet admins; Telegram General topic only), progress message edited in place. Daily notice "🆕 AgEnD {0} available…". | Reuse. Needs the Hub-recommended notice with a button. |
| Update engine | `agend update [--version X]`: looks the version up on npm, refuses a downgrade, hands off to that release's installer, restarts. | Reuse unchanged. Every path in this spec ends in this command. |
| Wait for idle agents | No. Update restarts at once; agents that were working get one recovery prompt afterwards. (A wait-for-idle exists only in the Windows runtime updater.) | New for step 3: wait until every agent is idle. |
| Rollback | Automatic when the Fleet runs as a service: the installer keeps the previous package and puts it back if the new service does not come up. `agend rollback <version>` is manual. A hand-started Fleet has no automatic rollback. | Step 3 is offered only to Fleets that run as a service. |
| Hub → Fleet notice | Only pairing security notices, with a fixed shape and no free text; web only, nothing to chat. | A second fixed-shape message: the recommended version. No free text from the Hub. |

## 2. Step 1 — the administrator sees versions

### 2.1 What the Fleet sends

When the link comes up, a Fleet that supports this sends its AgEnD version and whether it runs as a service. The Hub
stores, per Fleet: last reported version, when it was reported, and when the link was last up. A Fleet too old to
report has no version; the Hub knows only its capabilities.

### 2.2 Administration → Connected fleets

The existing card gains a summary line and three columns.

Summary line, above the list:

- All current: "All {0} Fleets are on the recommended version or newer." / 「{0} 個 Fleet 都是建議版本或更新的版本。」
- Some behind: "{0} of {1} Fleets need an update." / 「{1} 個 Fleet 當中有 {0} 個需要更新。」 with a filter chip
  "Needs update" / 「需要更新」.
- No recommended version set yet: "{0} active Fleets." / 「{0} 個使用中的 Fleet。」 "Active" means paired Fleets, not
  the ones online now. Step 1 has no way to set a recommended version, so the line stops there. With step 2 (card 2a)
  it gains a second sentence: "Set a recommended version to see which ones are behind." /
  「設定建議版本後，就能看出哪些落後。」

Columns per row (existing label, owner and Revoke menu stay):

| Column | EN | zh-TW | Value |
|---|---|---|---|
| Version | AgEnD version | AgEnD 版本 | `2.4.0-beta.1`, or "Unknown" / 「不明」 |
| Last connected | Last connected | 上次連接 | "Now" / 「目前已連接」 with a green dot, else a relative time ("3 days ago" / 「3 天前」), else "Never" / 「從未連接」 |
| State | (tag) | (標籤) | see below |

zh-TW uses 連接 for a Fleet's link to the Hub throughout, in line with 「已連接的 Fleet」; the Hub vocabulary gate
(U3, A-L14) keeps 連線 for network phrases only.

State tags, one per row, in this priority:

| Tag EN | zh-TW | When | Colour |
|---|---|---|---|
| Too old for rooms | 版本太舊，無法使用房間 | The Fleet lacks a capability a Hub feature needs (today: the room capabilities). This is the same condition as "Needs an AgEnD update" on an agent. | warn |
| Needs update | 需要更新 | Reported version is lower than the recommended version. | warn |
| Version unknown | 版本不明 | The Fleet has never reported a version (older than the release that adds reporting). Counted as needing an update. | warn |
| Up to date | 已是建議版本 | Reported version equals or is higher than the recommended version, or no recommended version is set and nothing is missing. | none |

A warn tag's one-sentence reason shows under the row, always visible (a tag is too small to be a tap target on a
phone, so it is not a hover or tap):

- Too old for rooms: "This Fleet's agents cannot answer in rooms until it is updated." /
  「這個 Fleet 的 Agent 要更新後才能在房間裡回答。」
- Needs update: "This Fleet runs {0}; the recommended version is {1}." / 「這個 Fleet 是 {0}，建議版本是 {1}。」
- Version unknown: "This Fleet is too old to report its version. Ask its owner to update it." /
  「這個 Fleet 版本太舊，無法回報版本。請通知擁有者更新。」

Phone: the row stacks as the Teams roster does (name, then labelled lines), tag first.

### 2.3 What the owner sees on the Hub (no Fleet change needed)

A Fleet that is too old cannot be told anything new over the link. Its owner still signs in to the Hub. So the Hub
itself shows a banner to a signed-in person whose own Fleet is flagged:

- EN: "Your Fleet "{0}" runs an older AgEnD ({1}). Some features here will not work until you update it. Open your
  AgEnD dashboard and press Update."
- zh-TW: 「你的 Fleet「{0}」是較舊的 AgEnD（{1}），這裡的部分功能要更新後才能使用。請開啟你的 AgEnD 儀表板，按「更新」。」
- With an unknown version, drop the parenthesis.
- One banner per person, listing at most one Fleet; with several, "{0} of your Fleets run an older AgEnD." /
  「你有 {0} 個 Fleet 是較舊的 AgEnD。」 Dismissible for the session; it returns on the next sign-in while still true.

This is the one piece that reaches the people who never update, so it belongs to step 1, not step 2.

### 2.4 The room label

"Needs an AgEnD update" on an agent stays. Add the owner's name to the member-panel line so people know whom to ask:
"Needs an AgEnD update · ask {0}" / 「需要更新 AgEnD · 請通知 {0}」.

## 3. Step 2 — a recommended version and the notice

### 3.1 Setting it (Hub administrator)

Administration → Connected fleets, a small card above the list: **Recommended AgEnD version** / 「建議的 AgEnD 版本」.

Three choices, radio buttons:

1. "Same as this Hub ({0})" / 「與這個 Hub 相同（{0}）」 — default once the card is first saved. It follows the Hub:
   when the Hub is updated, the recommendation moves with it. This is the choice that needs no upkeep.
2. "A specific version" / 「指定版本」 with one text box. The Hub checks that the version exists on npm before saving:
   "Version {0} was not found on npm." / 「在 npm 上找不到 {0} 這個版本。」
3. "No recommendation" / 「不建議版本」 — the state before anyone has set it. No notices are sent.

Under the choices: "Fleets below this version tell their owner and offer Update. Nothing is updated without the owner."
/ 「低於這個版本的 Fleet 會通知擁有者並提供更新按鈕。沒有擁有者的動作，不會更新任何東西。」

Save shows the effect before it applies, in the style of the group-permissions preview:
"{0} Fleets will be asked to update." / 「會有 {0} 個 Fleet 收到更新通知。」

### 3.2 What travels

The Hub sends each connected Fleet one fixed-shape message: the recommended version and when it was set. No text, no
link, no command. A Fleet that does not understand the message ignores it (it is covered by 2.3).

The Fleet decides everything else locally: it compares the version with its own, checks that the version exists on
npm under AgEnD's own package name, and raises the notice. A recommendation lower than or equal to the running
version does nothing.

### 3.3 The notice on the Fleet (owner)

**Web.** The existing update banner, with a different first line so the owner knows who is asking:

- EN: "{0} recommends AgEnD v{1} (current v{2})" · buttons **Update now** / **Later**
- zh-TW: 「{0} 建議更新到 AgEnD v{1}（目前 v{2}）」 · 「立即更新」／「稍後」
- {0} is the Hub's name as shown in Settings → Hub.
- Second line: "Some Hub features need it. Only admins see this." / 「部分 Hub 功能需要這個版本。只有管理員看得到。」

**Update now** opens the existing confirm ("Update AgEnD?" … **Update and restart**) and runs the existing update,
pinned to the recommended version. From there on, every screen is today's: the four steps, the failure texts, Reload.

Why pinned: the plain Update follows the Fleet's own channel. A stable Fleet would be taken to the newest stable
release, which can still be below what a preview Hub recommends, and the owner would be asked again. Pinning makes
one press enough.

**Later** hides the banner for 24 hours (today's behaviour). Settings → Advanced → "Version and update" gains one row:
"Recommended by {0}: v{1}" / 「{0} 建議的版本：v{1}」.

**Chat.** One message when a recommendation first applies to this Fleet, in the place the daily "🆕 AgEnD available"
notice goes today (General topic on Telegram):

- EN: "🆕 {0} recommends AgEnD v{1} (this Fleet runs v{2}). Some Hub features need it." · button **Update now**
- zh-TW: 「🆕 {0} 建議更新到 AgEnD v{1}（這個 Fleet 目前是 v{2}）。部分 Hub 功能需要這個版本。」 · 按鈕「立即更新」
- The button does what `/update` does, pinned to the version, and is honoured only from a Fleet admin; anyone else
  pressing it gets today's refusal.
- A reminder after 7 days if still behind, then every 7 days. Not daily: a daily nag is how notices get muted.

If the Hub's recommendation and the Fleet's own daily check would both show a banner, show one: the Hub's line when
the recommended version is the higher need, otherwise today's line.

### 3.4 Back on the Hub

The administrator's list updates by itself when a Fleet reconnects on the new version. A row whose Fleet has received
the recommendation shows, under the tag: "Owner notified {0}" / 「已通知擁有者 · {0}」 (relative time). A Fleet that could
not be told (too old, or never online since) shows "Not notified yet" / 「尚未通知」.

## 4. Step 3 — the owner lets the administrator update their Fleet

### 4.1 Opting in (Fleet owner)

Fleet Settings → Hub, inside the Hub connection card, under "Shared agents":

- Switch: **Let this Hub's administrator update this Fleet** / 「允許這個 Hub 的管理員更新這個 Fleet」. Off by default.
- Text under it:
  - EN: "When this is on, an administrator of {0} can start an AgEnD update on this computer. It installs only
    versions published by AgEnD, waits until your agents are idle, tells you before and after, and goes back to the
    previous version if the update fails. You can turn this off at any time."
  - zh-TW: 「開啟後，{0} 的管理員可以在這台電腦上啟動 AgEnD 更新。只會安裝 AgEnD 正式發布的版本，會等你的 Agent 都閒置才開始，
    更新前後都會通知你，失敗時會回到原本的版本。你隨時可以關閉。」
- Turning it on asks once: "Let {0}'s administrator update this Fleet?" / 「要允許 {0} 的管理員更新這個 Fleet 嗎？」
  **Allow** / **Cancel** — 「允許」／「取消」.
- When the Fleet does not run as a service, the switch is disabled with: "Not available: this AgEnD was started by
  hand, so a failed update could not be undone automatically." / 「無法使用：這個 AgEnD 是手動啟動的，更新失敗時無法自動復原。」
- Only on the Fleet's own dashboard, like the rest of Hub settings; not over the public link.

The Fleet tells the Hub whether the switch is on. Turning it off cancels a waiting request.

### 4.2 Starting an update (Hub administrator)

In the Connected fleets list:

- A row that needs an update and has the switch on shows a button **Update** / 「更新」. A row without the switch shows
  the small text "Owner updates it" / 「由擁有者自行更新」 instead.
- Above the list, when at least one row qualifies: **Update {0} Fleets that allow it** / 「更新 {0} 個已允許的 Fleet」.
- Confirm (the administrator's press is the consent on the Hub side):
  - EN: "Update {0} to AgEnD v{1}? It starts when that Fleet's agents are idle. Its owner is told now and when it
    finishes." · **Update** / **Cancel**
  - zh-TW: 「要把 {0} 更新到 AgEnD v{1} 嗎？會等那個 Fleet 的 Agent 都閒置才開始。現在和完成時都會通知擁有者。」 · 「更新」／「取消」
  - For several: "Update {0} Fleets to AgEnD v{1}?" / 「要把 {0} 個 Fleet 更新到 AgEnD v{1} 嗎？」
- The target is always the recommended version. The administrator cannot type another version here; to move people
  elsewhere, change the recommendation first. One rule, one place.

### 4.3 What the Fleet does with a request

The request carries a version and who pressed. The Fleet, not the Hub, decides and acts:

1. Refuse unless: the switch is on; the Fleet runs as a service; the version is higher than the running one; the
   version exists on npm under AgEnD's package; no update is already running.
2. Tell the owner (web notice and chat) that an update is waiting — text in 4.4.
3. Wait until every agent is idle. Idle means no agent is working, waiting on an approval, or mid-delivery. The wait
   lasts up to 24 hours; then the request expires and is reported.
4. Run the existing update for that version. Everything from here is today's path, including the automatic return to
   the previous version if the new service does not come up.
5. Tell the owner the result and report it to the Hub.

Nothing in the request is executed. It names a version; the Fleet fetches that version from npm itself.

### 4.4 What the owner sees

Web notice and one chat message at each point. {0} is the Hub name, {1} the administrator's name.

| Moment | EN | zh-TW |
|---|---|---|
| Waiting | "{1} ({0}) asked to update this Fleet to AgEnD v{2}. It will start when your agents are idle." · **Update now** / **Cancel update** | 「{1}（{0}）要求把這個 Fleet 更新到 AgEnD v{2}。會等你的 Agent 都閒置才開始。」 · 「立即更新」／「取消更新」 |
| Starting | today's progress texts | 現有的進度文字 |
| Done | "AgEnD is updated to v{2}, as {1} ({0}) asked." | 「AgEnD 已依 {1}（{0}）的要求更新到 v{2}。」 |
| Failed, rolled back | "The update to v{2} did not work. AgEnD is back on v{3}; nothing else changed." · **See the full log** | 「更新到 v{2} 沒有成功。AgEnD 已回到 v{3}，其他都沒有變更。」 · 「看完整紀錄」 |
| Expired | "The update {1} ({0}) asked for did not start: your agents were busy for 24 hours. You can update from here when ready." · **Update now** | 「{1}（{0}）要求的更新沒有開始：你的 Agent 連續 24 小時都在忙。方便時可以從這裡更新。」 · 「立即更新」 |
| Cancelled by owner | "Update cancelled. {1} ({0}) has been told." | 「已取消更新，並已通知 {1}（{0}）。」 |

**Update now** in the waiting notice skips the idle wait, with today's confirm. **Cancel update** needs no confirm.

### 4.5 What the administrator sees

Under the row's tag, one status line that replaces the Update button while a request is open:

| State | EN | zh-TW |
|---|---|---|
| Sent, Fleet offline | Waiting for the Fleet to connect | 等待 Fleet 連接 |
| Waiting for idle | Waiting for its agents to be idle · since {0} · **Cancel** | 等待 Agent 閒置 · {0} 起 · 「取消」 |
| Updating | Updating… | 更新中… |
| Done | Updated to v{0} · {1} | 已更新到 v{0} · {1} |
| Rolled back | Update failed; back on v{0} · **Try again** | 更新失敗，已回到 v{0} · 「再試一次」 |
| Expired | Did not start: agents were busy for 24 hours · **Try again** | 沒有開始：Agent 連續 24 小時都在忙 · 「再試一次」 |
| Cancelled by owner | The owner cancelled this update | 擁有者取消了這次更新 |
| Refused | see 5 | |

A request to an offline Fleet is kept for 7 days, then dropped with "Did not start: the Fleet has not connected for 7
days." / 「沒有開始：這個 Fleet 已經 7 天沒有連接。」

## 5. Failures and edge cases

| Case | What happens | Text (admin side unless noted) |
|---|---|---|
| Owner turned the switch off after the request | Fleet refuses | "The owner no longer allows updates from the Hub." / 「擁有者已不允許由 Hub 更新。」 |
| Fleet not run as a service | Fleet refuses; row never showed Update | — |
| Version not on npm from the Fleet's network | Fleet refuses | "That Fleet could not find v{0} on npm." / 「那個 Fleet 在 npm 上找不到 v{0}。」 |
| npm unreachable from the Fleet | Fails before anything changes | "That Fleet could not reach the update source. Nothing was changed." / 「那個 Fleet 連不上更新來源，沒有任何變更。」 |
| No permission to install | Fails before anything changes | "That Fleet has no permission to install updates. Its owner must update it by hand." / 「那個 Fleet 沒有安裝更新的權限，需要擁有者手動更新。」 |
| New version installed, service did not start | Automatic return to the previous version | "Rolled back" row state |
| Rollback itself fails | Fleet is down; the Hub sees it offline | "Update failed and the Fleet has not come back. Contact {0}." / 「更新失敗，而且 Fleet 沒有重新連接。請聯絡 {0}。」 The owner's chat gets today's "did not finish" message with the installer command. |
| Fleet already at or above the version | Nothing to do | "Already on v{0}." / 「已經是 v{0}。」 |
| Recommendation changed while a request waits | The waiting request keeps its version; a new press replaces it | — |
| Two administrators press at once | One request per Fleet; the second sees the first's status | — |
| Hub is older than a Fleet | Normal; "Up to date" | — |
| Fleet on a different channel (stable Fleet, beta recommendation) | Allowed: the owner or administrator chose that version explicitly. The confirm on both sides names the full version so "beta" is visible. | — |
| Hub recommends a version lower than the Fleet runs | Nothing is sent to that Fleet; no downgrade, ever | — |
| Fleet revoked on the Hub | Open requests dropped; no notices | — |
| Owner has several Fleets | Each row and each notice is per Fleet | — |

## 6. Journeys

**Administrator, first time.** Opens Administration → Connected fleets. Sees "12 Fleets connected. Set a recommended
version to see which ones are behind." Chooses "Same as this Hub (2.4.0-beta.2)", sees "5 Fleets will be asked to
update", saves. The list now says "5 of 12 Fleets need an update"; three show "Owner notified", two "Not notified yet"
(one too old, one offline). Two rows have an **Update** button because their owners opted in; the administrator
presses "Update 2 Fleets that allow it". A day later the list says 9 of 12 are current; the remaining three are
people to message.

**Member who never updates.** Signs in to the Hub to ask an agent. A banner says their Fleet runs an older AgEnD and
some features will not work. Later, on their own dashboard, the update banner reads "hub.example.com recommends AgEnD
v2.4.0-beta.2 (current v2.3.5)". They press **Update now**, confirm, watch the four steps, reload. On the Hub the
banner is gone and their agent's dot in the room is green.

**Member who opts in.** After that update, opens Settings → Hub and turns on "Let this Hub's administrator update
this Fleet". Three weeks later, a chat message says the administrator asked to update to v2.4.0 and it will start
when the agents are idle. That evening another message says AgEnD is updated to v2.4.0. They did nothing.

**Update that fails.** Same member, a later release. The message says the update did not work, AgEnD is back on the
previous version and nothing else changed. The administrator's row says "Update failed; back on v2.4.0 · Try again".

## 7. What this costs

Stated for the pre-launch pass; none of it blocks the pilot.

- **Step 1** tells the Hub administrator which AgEnD version each colleague runs and when their computer was last
  online. That is new information about colleagues' machines in the administrator's hands.
- **Step 2** lets the Hub choose a version number that the Fleet then offers to install. The Fleet only installs
  after its own admin presses and confirms, and only a version it finds on npm itself. A Hub that recommends a bad
  but published release can talk people into installing it.
- **Step 3** lets someone other than the owner cause software to be installed and the Fleet restarted on the owner's
  computer. The limits (opt-in, published versions only, no downgrade, service-managed only, idle only, owner told
  and able to cancel) bound it, but a taken-over Hub administrator account could move every opted-in Fleet to any
  newer published version at a time of its choosing. Agents that are idle may still have unsaved thinking in their
  sessions; the existing recovery prompt applies.
- **Idle wait** can mean an always-busy Fleet never updates. That is what the 24-hour expiry and the owner's
  **Update now** are for.

Deliberately not in this spec: a Hub that updates Fleets on a schedule without an administrator's press; a required
minimum version that disconnects old Fleets; the Hub sending anything but a version number; updating the Hub itself.

## 8. Cards, in dispatch order

After the room features. Owners are suggestions from who holds the code today.

**Phase 1 — see versions**

- 1a (Fleet side of the link, Cairn): report AgEnD version and "runs as a service" on connect.
- 1b (Hub server, Ridge): store version, last-reported and last-connected per Fleet; add them and the state to the
  admin overview; compute the three warn states from version, recommendation and capabilities.
- 1c (Hub UI, web-claude): Connected fleets — summary line, filter, columns, tags, phone layout (2.2).
- 1d (Hub UI, web-claude): the signed-in person's "your Fleet is older" banner (2.3) and the owner name on the room
  label (2.4). Depends on 1b only; works for Fleets too old to run 1a.
- 1e (skill + docs): hub skill section "Fleet versions"; what the tags mean.

**Phase 2 — recommend and notify**

- 2a (Hub server, Ridge): recommended-version setting (follow the Hub / specific / none), npm existence check,
  preview count, the fixed-shape message to Fleets, "notified" time per Fleet.
- 2b (Hub UI, web-claude): the Recommended AgEnD version card and the "Owner notified" line (3.1, 3.4).
- 2c (Fleet, Cairn): receive the recommendation; compare; verify on npm; expose it to the update state.
- 2d (Fleet UI + chat, dev-claude2): banner variant, pinned Update, Settings row, chat message with button, 7-day
  reminder, one-banner rule (3.3). Also retire the outdated web-only text "Updating from the web isn't available
  yet."
- 2e (skill + docs).

**Phase 3 — update for them**

- 3a (Fleet, Cairn): wait-for-idle before an update, with expiry and cancel. Useful on its own; could later back an
  "update when idle" choice in the Fleet's own dialog.
- 3b (Fleet, Cairn + dev-claude2): the opt-in switch in Settings → Hub and its disabled state (4.1); report the
  switch to the Hub.
- 3c (Hub server + link, Ridge): the update request, one per Fleet, 7-day hold for offline Fleets, status reports
  back, audit entry per press.
- 3d (Fleet, Cairn): handle a request — the checks in 4.3, owner notices in 4.4, run the existing update, report.
- 3e (Hub UI, web-claude): Update button, "Update N Fleets that allow it", confirm, status lines (4.2, 4.5).
- 3f (skill + docs), then one rehearsal: a service-managed Fleet updated from the Hub, one forced failure that rolls
  back, one busy Fleet that expires.

Decided (leader, 2026-11-15), as recommended:

| # | Question | Decision |
|---|---|---|
| V1 | Default recommendation | None until the administrator saves the card; then "Same as this Hub". |
| V2 | Chat reminder cadence | Once, then every 7 days while behind. |
| V3 | Idle wait limit | 24 hours, then expire and tell both sides. |
| V4 | May the administrator pick a version per Fleet? | No. Always the recommended version. |
| V5 | Hand-started Fleets in step 3 | Not offered, because a failure could not be undone. |
