---
name: hub
description: How the AgEnD Hub works from the user's side (experimental, alpha line only) — what a Hub is, setting one up, company sign-in, the administrator's Let colleagues join card and join codes, connecting a Fleet with the one Hub address box, held or queued connections, sharing agents and who may ask them, group permissions, limits and troubleshooting. Use it to answer "how do I … in the Hub".
roles: [general, worker, classic]
---

## How to use this skill

Look the question up in the index, then relay the short answer in the user's words. The labels below are the English
UI labels, with the 中文 label where people usually quote it. The Hub is **experimental and off by default**: nothing
here applies until someone has set up a Hub. Never invent a control that is not listed here, and never state a
company's own Hub address, directory server, group or account: ask the user or their Hub administrator for those.
What is not built yet is listed under [Not available yet](#not-available-yet); say so instead of guessing.

For signing in to a person's *own* dashboard (`/web`, codes, the authenticator app), load `web-dashboard`.

## Index

| The user asks about… | Section |
|---|---|
| what a Hub is, Hub vs Fleet, who can see what | [What the Hub is](#what-the-hub-is) |
| `agend hub init`, Set up a Hub, first administrator | [Setting up a Hub](#setting-up-a-hub) |
| move the Hub to another address or port, Hub address (Hub 位址) on the Hub's computer | [Changing the Hub's address](#changing-the-hubs-address) |
| Fleet connection address (Fleet 連接位址), the address Fleets connect to, Fleets that move | [Changing the Fleet connection address](#changing-the-fleet-connection-address) |
| the Hub's sign-in page, which account, wrong password | [Signing in to the Hub](#signing-in-to-the-hub) |
| Let colleagues join, 讓同仁加入, which groups, the sentence to send | [Letting colleagues join](#letting-colleagues-join) |
| join codes, 加入碼, create, end, used up, limits | [Join codes](#join-codes) |
| Settings → Hub, Hub address, "address space code", Join code included | [Connecting a Fleet](#connecting-a-fleet) |
| needs attention, Recover this connection, queue, timed out, cancel | [Held, refused and queued connections](#held-refused-and-queued-connections) |
| Shared agents, Share, Not shared, Pause sharing, Resume sharing, Stop sharing, ClassicBot rooms | [Sharing agents](#sharing-agents) |
| Allow someone to ask, AD group, name search, how long, Revoke, Recent questions | [Who may ask](#who-may-ask) |
| New chat, asking someone's agent, Waiting / Answered, favorites (最愛) | [Asking an agent](#asking-an-agent) |
| @agent, @all, room answers, Idle, Paused, Stopped | [Agents in a Hub room](#agents-in-a-hub-room) |
| room creators, room administration, Hub assistant | [Rooms and the Hub assistant](#rooms-and-the-hub-assistant) |
| Chat with agents / Share agents / Connect a fleet by AD group, Paused | [Group permissions](#group-permissions) |
| Room assistant, backend/account, cap, idle stop, answer counts | [Room assistant administration](#room-assistant-administration) |
| Connected fleets, Revoke, Individual invitations, pairing code, Notices | [Administration](#administration) |
| `hub`, `hub_member` in fleet.yaml | [Config keys](#config-keys) |
| how many, how long | [Limits](#limits) |
| custom roles, virtual teams, sharing a ClassicBot room | [Not available yet](#not-available-yet) |
| can't connect, certificate, different host names, old tab | [Troubleshooting](#troubleshooting) |

## What the Hub is

A **Fleet** is one person's AgEnD: their agents, on their computer. A **Hub** is a separate company server that Fleets
connect to, so colleagues can ask each other's agents. People sign in on the Hub with their **company account** (the
Active Directory account they use at work).

- A shared agent answers inside its own conversation on its owner's Fleet, with its own folder
  and the tools its Settings allow. Actions that need approval still go to the owner.
- A Hub with the optional room-assistant provider enabled can also answer through its own assistant. Its backend and
  account are chosen by the Hub administrator; it is separate from colleagues' shared agents. The pilot assistant
  runs on the Hub computer without shell, file or other tools and receives only the supplied room conversation.
- Every agent is private unless its owner shares it, and sharing alone lets nobody ask: the owner also allows each
  person or an AD security group.
- The Hub administrator manages who may connect and sees connected Fleets, not chats ("You cannot read anyone's chats
  here."). What was asked stays in the owner's Fleet chat.
- The Hub's pages are at `https://<hub address>/ui/hub`: **Chats**, **My shared agents** (who may ask them, until
  when), **Administration** (administrator only) and **Notices**.

## Setting up a Hub

Two front ends for the same setup; use either. Both need a directory reachable over **LDAPS** and a read-only service
account.

- **Terminal:** `agend hub init` on the computer that will run the Hub (it needs an interactive terminal). It asks for
  the Hub name, the address colleagues will open, the directory, and the first administrator's directory sign-in name,
  then for the word `initialize` to write the settings. `agend hub handoff` prints the hand-off notes again.
- **Browser:** on that computer's own dashboard, **Settings → Hub**, card **Set up a Hub** → **Set up on this
  computer**. Fill in the steps, **Test connection and review**, then **Create Hub**. The page then checks startup by
  itself ("Checking whether the Hub is ready…") and offers **Open Hub sign-in** once "The Hub is ready. You can open
  sign-in."
  - Only this computer's own sign-in gets the button. Anyone else reads: "To set up a Hub, go to the computer running
    AgEnD, run agend web in a terminal there, and set it up on the page it opens."
- **First administrator:** no personal password is asked during setup. The named person becomes administrator the
  first time they sign in to the Hub in a browser.
- The Hub and a Fleet's dashboard must have **different host names**; a different port is not enough.
- A generated browser certificate causes a browser warning until people trust it; its fingerprint is shown before the
  Hub is created.

## Changing the Hub's address

On the computer that runs the Hub, its own dashboard: **Settings → Hub**, card **Hub address** (Hub 位址), below **Run
this Hub**. Only that computer's own sign-in sees it, as with **Set up a Hub**.

- It shows the address, where the Hub listens and its certificate's fingerprint. **Change address** (變更位址) → **New
  address** (`hub.example.com` is enough, without `https://`; add `:port` if it isn't 443) → **Check** (檢查) → "Change the Hub's
  address?" → **Confirm change** (確認變更). **Back** changes nothing.
- The Hub listens on the address's own port. The current certificate is kept when the host name stays the same;
  another host name gets a new self-signed one (browsers warn until it's trusted; compare the fingerprint shown).
  **Advanced** (進階) sets the listening interface and port (for a router or reverse proxy that forwards another port), or **Use
  my own certificate** (paste the certificate and private key as PEM).
- After the change everyone, the administrator too, signs in to the Hub's pages again, and the old address stops
  working. Connected Fleets stay connected. Tell colleagues the new address: it's the one they type in Settings → Hub,
  and **Tell colleagues how to join** shows it.
- Messages: "Another program on this computer is using that port." → another port under **Advanced**; "That address or
  port is the one Fleets connect to." → another port; "Another change is still finishing, or a device is finishing its
  sign-in." → try again in a moment; "Saved, but the Hub doesn't answer at the new address yet…" → free that port, then
  turn **Run this Hub** off and on.
- The address Fleets connect to (the member address) is separate and isn't changed here.

## Changing the Fleet connection address

Rarely needed. On the Hub's computer: **Settings → Hub**, the folded card **Fleet connection address** (Fleet 連接位址), below
**Hub address**. It's where connected Fleets reach the Hub; the Hub address colleagues use doesn't change.

- **Change connection address** (變更連接位址) → **New connection address** → **Check** (檢查) → "Change the Fleet
  connection address?" lists **Fleets that move (*n*)** → **Confirm change** (確認變更). **Advanced** sets where it listens.
- Fleets **online** at that moment follow on their own (the Hub sends them the new address, signed with its key). Fleets
  offline lose their connection; their owners get a notice and press **Reconnect** (重新連接) on their own Settings → Hub,
  which signs in again with the company account. The card then says, for example, "Done. 3 of 4 Fleets followed. These must
  reconnect from their own Settings → Hub: *name*."
- On a Fleet whose connection the Hub ended, Settings → Hub shows **Reconnect** with "The Hub ended this Fleet's
  connection, for example after it moved the address Fleets connect to."

## Signing in to the Hub

The page is **Sign in to the Hub** (登入 Hub): "Use your company account. Your password goes to the directory only and
is never kept." Fields **Account** and **Password**, button **Sign in**.

- The Hub signs in with the company account and password only. A code from `/web` or an authenticator app is for a
  person's own dashboard and does nothing here.
- "That account and password didn't work." → wrong account or password. "The directory can't be reached right now. Try
  again later." → the Hub cannot reach the company directory; nothing the user typed is wrong.
- When the page was opened from a Fleet that is connecting, the button reads **Sign in and connect Fleet**: that one
  press signs in and approves the connection.

## Letting colleagues join

For the Hub administrator. **Administration** opens with the **Let colleagues join** card (讓同仁加入); while no Fleet is
connected, the same card is also on the administrator's welcome page. Three steps; steps 1 and 2 show **Done** from
what the Hub has saved.

1. **Let colleagues connect Fleets with their company account** — turn on **Allow company-account Fleet connections**.
2. **Who can join** — search for the AD groups whose members may connect (type the start of the name) and add them. For
   each group set **Each person up to** *N* **Fleets**, and whether its members may also **Chat with agents** and
   **Share agents**. The card shows what the change does before **Save**. A group the search does not find goes under
   **Add by distinguished name**. A live join code also completes this step.
   - Group search needs Active Directory over LDAPS. If the directory cannot list groups the card says so: check it
     with **Edit AD connection** on the Administration page, or use individual invitations or a join code.
3. **Tell colleagues how to join** — once 1 and 2 are done the card shows one sentence with the Hub's address ("In
   AgEnD, open Settings → Hub, enter *hub.example.com*, then sign in with the company account.") and **Copy these
   instructions**. Before that the button is off: "Finish steps 1 and 2 first." Join codes are created here too.

Under the card: **Individual invitations** (see [Administration](#administration)) and **Link with key fingerprint
(Advanced)**, a long link that also carries the Hub's identity, for a colleague who must check the fingerprint by
hand. Step 2's **All group permissions** opens the full group editor, described under
[Group permissions](#group-permissions).

## Join codes

A join code (加入碼) lets many people connect at once without adding a group first, for example everyone at a workshop.
Only the configured Hub administrator can manage them.

**Create.** In step 3 of the card, **Create join code**:
- **Valid until:** In 1 hour, End of today (the default), or In 7 days. A code cannot be extended.
- **Maximum Fleets:** 1–200, 30 by default.
- **Who can use it:** Anyone in the company directory, or One company group (search, or **Use the group's
  distinguished name** → **Find group**).
- Under **More**, **Fleets per person:** 1–8, 1 by default.

The card then shows the code (8 characters, `XXXX-XXXX`) and "In AgEnD Settings → Hub, enter *hub.example.com* and this
code." **Copy** copies that sentence with the code on the next line.

**While it is live** the row shows **Active**, **Connected** *n* / *max*, how many connections are in progress, and
**Recent connections** (Fleet, owner, time). If the Hub has fewer free places than the code allows: "Only *n* Fleet
spaces remain on this Hub. This code allows up to *m* connections; extra connections will be refused."

**End.** **End this code now** asks first, **End this join code?**: "This code cannot be used again.", the Fleet
connections still in progress with it stop (it names them), and "Fleets already connected are unchanged." A code also
ends by itself as **Expired** or **Used up**; ended codes stay listed for 7 days.

**Limits.** "At most 8 join codes can be live. End one before creating another." and "At most 10 join codes can be
created in one hour. Try again later."

**What a code is.** It stands in for the administrator's approval of the connection only: "A company account is still
required. This code allows a Fleet connection; it does not allow asking or sharing Agents." Treat a live code like a
key: anyone in its scope who gets it can connect a Fleet under their own name until it ends.

**After joining by code.** The code adds nothing beyond the connection, and takes nothing away. What the person can do
next is what they could do without it:
- **Asking, group permissions never turned on:** they can ask an agent as soon as its owner allows them, like anyone
  who signs in. Do not tell them to have group permissions turned on for this: that switch changes access for everyone.
- **Asking, group permissions on:** they need **Chat with agents** from one of their groups *and* the owner's
  allowance. In no allowed group, they cannot chat until a group allows it.
- **Sharing** is never given by a code. The Hub has to allow that person to share; until it does, the row reads "Not
  shared: your Hub administrator hasn't allowed you to share agents."
- Either way the owner still allows each asker ([Who may ask](#who-may-ask)); no code or group replaces that.

## Connecting a Fleet

For everyone. On your own dashboard: **Settings → Hub**. There is one box, **Hub address** (Hub 位址), and no switch to
turn on first.

1. Type the address the administrator gave you; `hub.example.com` is enough, without `https://`.
   - **With a join code:** the address, a space, then the code: `hub.example.com ABCD-EFGH`. Pasting the
     administrator's whole message works too. The page then says **Join code included.** (已帶入加入碼。)
   - A code on its own gets: "That is a join code. Put the Hub address before it, with a space: …"
   - A link from the administrator (`https://…/join-info#…`) goes in the same box.
2. The page looks the Hub up ("Looking up the Hub…") and shows **Found "*Hub name*". This Fleet will appear as
   "*name*".** The name is this computer's name; **Rename** changes it.
3. Press **Sign in with company account** (以公司帳號登入). A Hub tab opens; sign in there and press **Sign in and
   connect Fleet**.
   - If the page first asks you to confirm it is really you, do that on the confirm card (**Go to the confirm card**),
     or press Confirm on the card in General when the page names Discord or Telegram. The Hub sign-in opens after
     that. A dashboard that asks for your authenticator code shows the field in the same card.
4. The Hub tab says "Connected. You can close this tab." and closes by itself. The Fleet page shows **Connected with
   *your name*'s company account · This Fleet is called "*name*"** and "Your Fleet is connected. You can now choose
   which Agents to share below."

**Self-signed test Hub.** A Fleet running an alpha build permits pilot trust by default; stable builds default off.
In the **Hub address** box, a valid self-signed certificate shows **This Hub uses a self-signed test certificate**
(這個 Hub 用的是測試用的自簽憑證), its **Certificate fingerprint** (憑證指紋), and **Show the full fingerprint**
(顯示完整指紋). Press **Trust this Hub and continue** (信任這個 Hub 並繼續) only for your team's pilot Hub, or
**Cancel** (取消). That press saves the exact certificate for this Hub address and opens company sign-in; a join code
already typed stays included. The found line then says **You trusted this Hub's self-signed certificate (for testing).**
(已信任這個 Hub 的自簽憑證（測試用）。). If that certificate changes, the saved pin refuses the connection;
after the administrator confirms replacement, **Trust again and continue** (重新信任並繼續) explicitly replaces it.
The Fleet's **Allow trusting a Hub with a self-signed certificate (for testing)** (允許信任自簽憑證的 Hub（測試用）)
switch stays available in **Settings → Hub**, including after connection. Turn it off after the pilot or when the Hub
uses a trusted certificate. With it off, Hub discovery requires ordinary certificate trust. A trusted certificate needs
no prompt; expired certificates, incorrect host names and an untrusted issuing chain keep the certificate error.

Connecting shares nothing. **Reconnect** appears when the connection stopped (revoked, expired or refused): one press
ends the old connection and opens the Hub sign-in again. **Remove this connection** ends it from your side ("Agents
you share will stop answering.").

Reconnecting after revocation or removal creates a new Fleet identity on the same Hub. Its member journal and sharing
consent are separate from the previous identity: old questions and receipts are not replayed. An ordinary network
reconnect of the same identity keeps its delivery and acknowledgement history. Do not delete journal files to repair a
connection; partial or inconsistent state is held rather than reset.

**Other ways** holds the older **pairing code** method, and appears only for a Hub without company sign-in: once the
Hub typed in **Hub address** answers that it takes company sign-in, **Other ways** is hidden and the company sign-in is
the one way in. It stays while the Hub cannot be reached or its certificate is not trusted. A pairing code pasted into
the address box opens it filled in. Its switch **Allow this fleet to connect to a Hub** (under **Hub membership**)
applies as soon as it is changed.

The pairing form checks the code before anything is confirmed. A pairing code is 12 characters, 0–9 and a–f (dashes
and spaces are ignored). A join code (XXXX-XXXX) typed there is pointed back to the **Hub address** box at the top of the card:
the address, a space, then the join code. The form's address is the one shown with the pairing code (it ends in a port), not the address of
the Hub's pages. When a confirmed pairing is not applied, the page says why, for example "Confirmed, but it was not
applied: the Hub refused this pairing code (used, expired or not issued for this Hub)."

## Held, refused and queued connections

One attempt lasts at most 10 minutes. The page says what happened; do what it names rather than starting again.

| The page says | What to do |
|---|---|
| Many people are connecting at once. Waiting in the queue… / Waiting in the queue… Retry *n* of 8. | Nothing. The Hub tab retries the same request by itself, up to 8 times a few seconds apart. It never creates a second Fleet. |
| The Hub is handling other connections and will retry shortly. | Nothing; same queue, seen from the Fleet page. |
| The Hub is busy. Check this same connection again shortly. | Press the retry on that message; it is still the same request. |
| **Connection needs attention** | The attempt is held. **Recover this connection** (恢復這次連接) continues the same saved attempt; **Cancel connection** ends it. When the result is unknown, **Check again** (再次檢查) also appears: it asks the Hub how the attempt ended. |
| Another connection attempt is still open (shown above). | Use **Recover this connection** or **Cancel connection** on it, then start again. A refused or held attempt no longer blocks the next one for 10 minutes once it is cancelled. |
| This attempt was started in another browser tab or session. | Recover or cancel it here, or finish it there. |
| The result could not be confirmed. | Use **Check again** on that connection. Do not start another one: a Fleet may already exist on the Hub. |
| This attempt timed out and nothing was created. | Press **Sign in with company account** again. |
| This connection request expired. | If a Fleet was already created, inspect or revoke that exact Fleet on the Hub (**Open Hub**) before starting again. |
| Your company account may not connect a Fleet. | Ask the Hub administrator to add you or one of your groups, or for a join code. |
| The Hub did not accept this join code… | It ended, was mistyped, or your account may not connect. Ask for a current code, then start again. |
| This join code is no longer valid or has been used up. / You are outside the scope of this join code. | Ask the Hub administrator for a new code, or one for your group. |
| You have reached the limit of connected Fleets. | Revoke one of your Fleets on the Hub first. |
| "*Hub*" presents a different identity than before. | Nothing was connected. Confirm with the Hub administrator before choosing **Replace saved Hub identity**. |

## Sharing agents

On your Fleet, **Settings → Hub**, under **Shared agents** (分享的 Agent), once connected.

- Each agent has a switch, **Share** *name*. Turning it on asks for your confirmation first ("Waiting for your
  confirmation"): on the confirm card at the top of the page, or on the card in General when the page names Discord or
  Telegram. Then the row reads "Shared: Hub questions go to this agent's own conversation."
- Turning the switch off withdraws the agent.
- **Who may share:** when group permissions are on, only people whose group has **Share agents**. Otherwise the row
  reads "Not shared: your Hub administrator hasn't allowed you to share agents. It will be shared once they do."
  (未分享：Hub 管理員還沒有允許你分享 Agent。) with **Don't share it** to take the request back.
- Only fleet agents can be shared for now: "ClassicBot rooms can't be shared yet." A Fleet with nothing to share reads
  "This fleet has no agents to share yet."
- "Shared under the older restricted mode. Hub questions are refused until you share this agent again." → **Share
  again**.
- On the Hub, under **My shared agents**, an owner can **Pause sharing** (暫停分享) and **Resume sharing** (繼續分享). Pause hides the agent from new-chat choices and refuses new questions; existing authorized chats say **Sharing paused** and stay readable. Person and AD group grants, IDs and original expiry dates are kept. Expiry time keeps running: resume does not extend or resurrect an expired/revoked grant, and live AD membership and Hub group permissions still apply. Reconnecting the Fleet or restarting the Hub never resumes sharing.
- Pause is not instantaneous cancellation: a pre-Pause authorization whose result is already travelling to the Fleet may start its one first input within its existing lease (at most five seconds). Already-running work may finish. The committed authorization version makes members reconnect; after a member observes that fence, old capabilities stay unusable even after Resume. No new authorization is admitted while paused, and old answer-release leases are retired immediately. Do not promise an instant halt or automatic replay.
- **Stop sharing…** (停止分享) is separate and permanent for the current publication. It means: "No one can ask it any more. To share it again, it has to
  be shared again from its fleet, and everyone has to be allowed to ask again. What was asked stays readable." Its
  state then reads **Sharing stopped on the Hub**. Resume cannot undo Stop sharing or a Hub policy hold. The Fleet Share switch still controls publication; use the Hub page for a resumable pause.

## Who may ask

Sharing lets nobody ask yet. The owner allows a person or an AD security group; Hub eligibility and operational group permissions still apply.

- From the Fleet row, **Allow someone to ask…** opens the Hub at the agent's page; or on the Hub: **My shared agents**
  → the agent → **Who may ask** → **Allow…**.
- On a supported AD Hub, **Allow access to** *agent* offers **A person** (search the beginning of their name or login) or **An AD security group** (the same group-search control as Let colleagues join). Select a result, choose **Access lasts** 1, 7 (default), 30 or 90 days, then **Allow**.
- Group grants bind the directory's immutable GUID, not its name. Every action checks fresh direct membership; nested and primary groups are not included. An AD group manager can change who may ask, as the dialog explains. Each person's chat stays private. Joining or leaving takes effect on the next check. Unknown membership is unavailable, not a grant removal.
- New personal and group grants are capped at 90 days server-side. Existing longer grants keep their recorded expiry, ID and revision, and remain revocable; show their actual date without shortening it.
- An older tab or unsupported directory retains the dialog **Allow someone to ask** *agent*: **Their sign-in name**, by exact login, and **For** 1, 7, 30 or 90 days.
- A person covered by several grants sees one agent entry, preferring an existing still-authorized conversation. History is never transferred to a different grant.
- Each row shows the person or group and "until *date*"; a group has an **AD group** tag. A person allowed before they ever used the Hub is tagged **Hasn't
  signed in to Hub yet** (還沒登入過 Hub).
- **Revoke…** on a row: "Revoke *name*'s access? Their conversation closes."
- **Recent questions**: who asked, when, and whether it was answered. What they asked stays in the Fleet's chat.
- **Subscription quota** → **Show quota to people asking**: shares only a broad band (Available, Near limit,
  Exhausted, Unknown). Exact usage stays in the Fleet.

## Asking an agent

On the Hub: **Chats** → **New chat** lists only the agents someone allowed you to ask ("Answers for *owner* · you can
ask until *date*"). Pick one and **Ask**.

The chat list (the sidebar; on a phone, the Chats page) looks like AgEnD's own chat list. Each chat is a row with the
agent's avatar, its name and its owner below it; a question still waiting shows the working dot and **Waiting for an
answer**, and a closed chat says **Closed**. Ctrl K (⌘K on a Mac) filters it by an agent's name or its owner. On a Hub
that has rooms, the list has two groups: **Rooms** (房間: a square avatar, "3 people · 12 agents", unread count, an @
mark when someone mentioned you) and **Agents** (one-to-one chats, the agent's status dot, **Hub assistant** last).
Unread chats come first, then the most recent.

Favorites work as in AgEnD's own sidebar: a row's **⋯** menu has **Add to favorites** (加入最愛) and **Remove from
favorites**. Starred chats and rooms move to **Favorites** (最愛) at the top of the list, in the order you starred them,
at most 50. With two or more, **Edit** adds **Move up** and **Move down** to their menus; clear the filter first to move
them. For now, a Hub's favorites are kept in this browser for the person signed in, so another browser or device
starts without them. A chat or room you leave drops out of Favorites.

In a room (a Hub with rooms), everyone sees every message. Each message says who wrote it: a person by name, an agent as
"*agent* · *owner*'s agent", the room assistant as "Room assistant · Provided by the Hub". An agent answers only when it is
@-mentioned: type `@` for the menu — **@All agents** (every agent answers; the line above the box says how many are online
and how many answer when they're back), **@Room assistant**, each agent (its owner and status dot), then people (an @ to a
person only reminds them). Under a message that asked several agents a line shows the progress ("Answered 7 · working 2 ·
reply later 3"); each answer is a reply to that message. A message with no @agent is only for the people in the room. If
the room doesn't let members @All agents, is archived, or you've left it, the box says so. The **Hub assistant** is the
last chat under **Agents**: your own chat with the Hub's AI, which can't read your computer or other rooms. The room's
header menu (⋯) has **Room settings** (room managers) and **Leave room** (everyone; the last room manager is asked to make
someone else a manager first). Once an **@All agents** question has answers, **Ask the room assistant to summarise**
(請房間助理整理) under them sends "@Room assistant summarise the answers above". **New room**, **Invitations** and
**Administration → Rooms** are in the sidebar, the list (on a phone, beside **New chat**) and Administration; on a
phone, the back arrow in a room's header returns to the list.

- "You're asking as yourself: the owner sees that you asked. The agent answers within what its owner allows."
- Everyone who asks one agent shares its one conversation, so it may remember what others asked. Don't send what other
  askers shouldn't see.
- The marks on a question: **Waiting for the owner's fleet**, **At the owner's fleet**, **Answered**; or **Not
  answered** / **Outcome unknown**. "An answer can take a few minutes."
- "No agents have been shared with you yet. An agent's owner has to give you access." → ask the owner to allow you.

## Agents in a Hub room

On a Hub with rooms, mention a shared agent with **@agent**, or **@all** when the room allows it. A room manager can
add their own shared agent. Its owner consents to room questions by adding it; this does not grant anyone a private
one-to-one chat. The separate **Who may ask** list still controls private chats.

- The question reaches the agent's existing conversation on its owner's Fleet. It names the room and asker and
  includes recent room messages. The agent keeps its own folder and tools; any required approval goes to its owner.
- Everyone in the room can see the question and answer. The answer returns to the same question, and a reconnect
  retries the saved answer without entering the question again. Room agent answers are text only for now.
- **Idle** (待命) means the agent can be woken by a question. **Working** means it is busy. **Paused** (暫停) names a
  known reason such as quota, sign-in or approval. **Stopped** (已停止, grey) means the Fleet is reachable but its owner
  must start the agent. **Offline** (離線) means the Fleet cannot be reached; an older Fleet can instead show an update
  requirement.
- Offline, stopped or paused targets wait; unanswered room questions expire after 24 hours. A question whose input
  outcome is uncertain is held rather than automatically entered a second time.

### Inviting another owner's agent

When the Hub offers room invitations, a room manager can invite another owner's shared agent. The owner sees
**Invitations** (邀請) above the chat list and at the top of **My shared agents**. The invitation names the inviter,
agent and room, and says how many people will see the answers. **Agree** (同意) adds the agent; **Decline** (不要)
does not. The owner does not become a person in that room and cannot read its messages just by accepting.

- An invitation lasts seven days from when it was sent. Repeating a pending invitation does not extend it. The
  manager can clear an expired invitation or send a new one; the replacement takes the old entry’s place.
- Pausing sharing keeps existing room membership and pending invitations, while their expiry clocks keep running.
  Resume sharing before accepting a pending invitation; an expired invitation needs a new invitation.
- On the shared agent's page, **In these rooms** (在這些房間裡) lists its rooms. **Leave this room** removes the agent.
  Replaying the old acceptance does not join it again; a new invitation is needed.
- A manager can add their own shared agent directly. This remains separate from private **Who may ask** grants.

These controls need the matching invitation service and room UI. Do not invent them on an older Hub. Virtual-team
management remains a separate slice. The Hub room assistant is described in the next section.

## Rooms and the Hub assistant

These controls require the rooms UI and its matching server. An older page may still show direct chats only; reload
after an upgrade. Do not offer an assistant when the Hub has no enabled assistant provider.

- The Hub administrator chooses the people or Teams who may create rooms. Team-based creation follows the current
  roster. Removing that permission prevents new rooms; existing room managers keep their rooms.
- People expanded from a Team when a room is created stay room members if the Team later changes or is deleted.
- An AD group adds its currently eligible direct members, including people who have not signed in to the Hub yet;
  nested groups are not expanded. Later directory changes do not rewrite the room's member list. A room holds at
  most 100 people, counting the creator and deduplicating all selected people, groups and Teams. An incomplete
  directory read or an over-limit selection creates nothing; choose a smaller group or Team, or try again later.
- A selected person can see the room on their first Hub sign-in. Until then the member list can mark them as not
  having signed in; selection does not sign them in or create a session.
- Administration shows room names, member counts, managers and activity times. It does not grant access to room
  messages. An administrator must explicitly join as a room manager to read or participate, under the room's history
  setting. Archiving keeps members and saved history, and stops new messages.
- When enabled, each person has a private Hub-assistant conversation. Plain messages there ask the assistant; in a
  group room, add the assistant and mention it. If it cannot answer, the person's message stays saved with a warning.
- Removing the assistant or archiving a room stops its pending work. Stopping it in administration also cancels the
  room's queued inputs. An interrupted answer is not automatically repeated after a restart.
- Agent owners can see which rooms their agent is in and remove it. Pausing sharing keeps its room membership;
  invitations to another owner's agent still require that owner's acceptance when the invitation service is available.
## Group permissions

Optional, for the Hub administrator; needs Active Directory over LDAPS (port 636). Step 2 of **Let colleagues join**
covers the everyday case. The full editor (turn off, **Paused**, **People excluded**) is a separate page: on
**Administration**, step 2 of **Let colleagues join** has **All group permissions** (所有群組權限), which opens it;
from the dashboard of the Fleet that hosts the Hub, **Settings → Hub**, card **Group permissions** → **Open on the Hub**;
or, signed in as the administrator, the address `https://<hub address>/ui/hub/admin?view=groups`. Until group permissions
are turned on, the Hub behaves as before: everyone who signs in can chat, and connecting needs the administrator's
approval or a join code.

- Three permissions per AD security group: **Chat with agents**, **Share agents**, **Connect a fleet** with a
  **Fleets** number (0–8). A person in several groups gets everything any group allows and the highest Fleets number.
  **People excluded** win over any group.
- The editor shows **What this change does** before **Save** (**Turn on and save** the first time).
- **Turn off** pauses what depends on groups (chatting, sharing, self-service connecting), for the administrator too.
  Turning it on again resumes nothing by itself: **Resume** each paused item under **Paused**.
- What a colleague sees on the Hub welcome page: cards **Chat with an agent** and **Connect your fleet**, on or off
  with the reason ("Connecting a fleet is not included in your access.", "Paused by your Hub admin.", "Your account
  can sign in, but no actions are allowed yet.").

## Room assistant administration

On a Hub that offers the room-assistant pilot, a Hub administrator opens **Administration → Room assistant**
(房間助理). An older Hub or cached client without this capability leaves these cards out.

- **Enable the room assistant** (啟用房間助理), **Backend**, **Account**: the pilot offers only a qualified tools-off
  Claude backend and existing accounts on the Hub computer. Sign in there under AgEnD Settings first; a colleague
  connecting their own Fleet does not provide the assistant's login. It uses the selected account's quota.
- **At most this many at once** defaults to 3 (range 1–16); **Stop after this many idle minutes** defaults to 15
  (range 1–240). Extra asks queue in arrival order, with one answer at a time per room. The oldest idle room
  controller may be retired to free capacity. A fresh worker answers each ask and then closes.
- **Now** (現在) lists answering or idle room controllers and their last use. **Stop** stops that room's current
  assistant; a later ask can start it again. It does not remove the assistant from the room.
- **Usage** (用量) shows seven UTC calendar days of answer counts and the selected account's coarse quota band.
  It is not a per-person billing report. A counter-storage warning does not mean an answer was lost.
- **Save** applies changed settings after old workers stop; saving unchanged settings leaves current answers alone.
  A failed save leaves the form's edits in place for another try.

If an assistant turn is not answered, the Hub host's log records `Hub room assistant could not answer` with its
request/room IDs and processing phase (and a protocol code when available), without the room text or raw vendor
error. Previously failed turns are not replayed after an upgrade; send a new message to retry.

Each answer uses the latest 30 supplied room messages, plus a replied-to message when it is older. The assistant
keeps no earlier model conversation, sees no other room and has no tools. Room membership, mentions and delivery
are supplied by the rooms-server integration; these admin cards alone do not add a chat room or enable an account.

## Administration

- **Connected fleets** lists each Fleet by its name with its owner under it. A row's menu has **Revoke…**: "It
  disconnects and everything it shares is withdrawn." Revoked Fleets fold under **Revoked (*n*)**.
  A revoked Fleet's old publications stay hidden even if it reconnects as a new Fleet. Reconnecting does not restore those shares; other active agents and their chats remain available.
- **Individual invitations** (個別邀請): **Company sign-in name** → **Create invitation** → **Copy invitation**. It lets
  one named, eligible person connect a Fleet without being in an allowed group. Issuing it is the administrator's
  approval; it is bound to that person and this Hub, allows one Fleet connection, and gives no chat or share rights.
- **Advanced: connect with a pairing code** is the older three-step pairing (make a code, the owner checks the
  fingerprint, the administrator approves). A refusal there names the owner: "*name* can't connect a Fleet right now:
  they aren't in the allowed groups, or they've been blocked from connecting."
- **Notices**: "When a new fleet connects to this Hub, you're told here. If you don't recognize it, revoke it." A Fleet
  that joined by code reads "Approved with a join code by your Hub administrator." Directory connection changes are
  listed there too and need **Acknowledge**.
- **This Hub** shows the Hub's name (**Hub name**, up to 64 characters) and what identifies it; **Edit AD connection**
  opens the directory settings.

## Config keys

Two keys in `fleet.yaml`, both off unless something turned them on. Prefer the pages above to editing them.

| Key | Meaning |
|---|---|
| `hub.enabled` | This installation runs a Hub. Set by `agend hub init` or **Set up a Hub**. The Hub's own settings are written by setup and changed on the pages, not by hand: its address in **Settings → Hub → Hub address** on the Hub's computer, its directory and name on the Hub's Administration page. |
| `hub_member.enabled` | This Fleet may connect to a Hub. Connecting with the Hub address box turns it on by itself; the switch is **Allow this fleet to connect to a Hub**. |

## Limits

| What | Limit |
|---|---|
| Fleets connected to one Hub | 256 |
| Fleets per person | set per group or per join code, 0–8 |
| Agents one Fleet can share | 64 ("At most 64 agents can be shared.") |
| Join codes | 8 live at once, 10 created per hour; 1–200 Fleets each (30 by default); valid 1 hour, to the end of today, or 7 days |
| One connection attempt | 10 minutes |
| Queue retries when the Hub is busy | 8 |
| An individual invitation | valid 10 minutes |
| A pairing code (Other ways) | 10 minutes, single use |
| Allow someone to ask | 1, 7, 30 or 90 days |

## Not available yet

Say plainly that these are not in the product yet:

- **Custom roles and a manager's team view** (several administrators, roles assigned to people or AD groups, a team
  list with usage counts). Designed and decided; not shipped. Today there is one Hub administrator.
- **Sharing a ClassicBot room.** Only fleet agents can be shared.
- **Virtual teams and team-based grants.** They are separate from the existing AD-group grants.
- **A second sign-in factor on the Hub.** It uses the company account and password only.
- **Adding to People excluded from the editor.** The list is shown; it cannot be edited there in this release.
- **Per-person cost or quota figures on the Hub.** Exact usage stays in each Fleet.

## Troubleshooting

- **"That is not a Hub address."** Enter just the address (`hub.example.com`), or the address, a space and the join
  code. **"A Hub address must use https."** Drop `http://`.
- **"*host* cannot be reached."** Check the address, and that this computer is on the company network.
- **"This computer does not trust *host*'s certificate."** Nothing was connected. The Hub's certificate must be
  trusted by the computer running the Fleet; check with the Hub administrator.
- **"*host* is not an AgEnD Hub."** Wrong address; ask the Hub administrator.
- **""*Hub*" does not accept company-account connections yet."** The administrator has not turned on step 1 of **Let
  colleagues join**.
- **"The Hub and this Fleet need different host names."** Open the Fleet's dashboard under a different host name than
  the Hub's; a different port is not enough.
- **Connected, but the share switch says Not shared.** The Hub has not allowed you to share agents; with group
  permissions on, no group gives you **Share agents**. This is expected after joining by code alone; ask the Hub
  administrator.
- **Nothing to ask in New chat.** No owner has allowed you yet; being connected is not enough.
- **A question stays at "Waiting for the owner's fleet".** It has not reached the owner's Fleet yet; ask the owner
  whether their AgEnD is running and connected.
- **The Set up a Hub card has no button.** Only this computer's own sign-in can set up a Hub: run `agend web` on the
  computer running AgEnD.
- **Pages look half old after an upgrade.** A tab opened before the upgrade can mix old and new pages. Reload it once.
- **"Only the Hub administrator can see this"** on Administration: you are signed in, but not as the administrator.
