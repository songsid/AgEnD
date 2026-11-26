---
name: hub
description: How the AgEnD Hub works from the user's side (preview, off by default) — what a Hub is, setting one up, company sign-in, the administrator's Let colleagues join card and join codes, connecting a Fleet with the one Hub address box, held or queued connections, sharing agents and who may ask them, group permissions, limits and troubleshooting. Use it to answer "how do I … in the Hub".
roles: [general, worker, classic]
---

## How to use this skill

Look the question up in the index, then relay the short answer in the user's words. The labels below are the English
UI labels, with the 中文 label where people usually quote it. The Hub is **a preview and off by default**: nothing
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
| My AI apps, 我的 AI App, Claude Code or Codex without AgEnD, remote MCP consent | [Connecting your own AI app](#connecting-your-own-ai-app) |
| Let colleagues join, 讓同仁加入, which groups, the sentence to send | [Letting colleagues join](#letting-colleagues-join) |
| join codes, 加入碼, create, end, used up, limits | [Join codes](#join-codes) |
| Settings → Hub, Hub address, "address space code", Join code included | [Connecting a Fleet](#connecting-a-fleet) |
| needs attention, Recover this connection, queue, timed out, cancel | [Held, refused and queued connections](#held-refused-and-queued-connections) |
| Shared agents, Share, Not shared, Pause sharing, Resume sharing, Stop sharing, ClassicBot rooms | [Sharing agents](#sharing-agents) |
| Allow someone to ask, AD group, name search, how long, Revoke, Recent questions | [Who may ask](#who-may-ask) |
| New chat, asking someone's agent, Waiting / Answered, favorites (最愛) | [Asking an agent](#asking-an-agent) |
| @agent, @all, room answers, Idle, Paused, Stopped | [Agents in a Hub room](#agents-in-a-hub-room) |
| room creators, room administration, Hub assistant | [Rooms and the Hub assistant](#rooms-and-the-hub-assistant) |
| Chat with agents / Share agents / Connect a Fleet by AD group / team / person, Paused | [Group permissions](#group-permissions) |
| Room assistant, backend/account, cap, idle stop, answer counts | [Room assistant administration](#room-assistant-administration) |
| Connected fleets, Revoke, Individual invitations, pairing code, Notices | [Administration](#administration) |
| AgEnD version of a Fleet, Needs update (需要更新), Too old for rooms, Version unknown, "Your Fleet runs an older AgEnD" | [Fleet versions](#fleet-versions) |
| `hub`, `hub_member` in fleet.yaml | [Config keys](#config-keys) |
| how many, how long | [Limits](#limits) |
| virtual teams, My teams, team lead, team grants | [Teams](#teams) |
| Roles, second administrator, assignments, audit, migration, roles off | [Roles and permissions](#roles-and-permissions) |
| sharing a ClassicBot room | [Sharing agents](#sharing-agents) |
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
- The Hub's pages are at `https://<hub address>/ui/hub`: **Chats**, **My agents** (who may ask them, until
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
  port is the one Fleets connect to." → another port; "Another settings change is still in progress." → try again in a
  moment; "Saved, but the Hub doesn't answer at the new address yet…" → free that port, then
  turn **Run this Hub** off and on.
- If a colleague's Fleet is joining, either address card shows when to retry in your local time. A recent join can hold
  the change for up to ten minutes after it began, even if its Fleet already looks connected. Wait until the displayed
  time, then **Check** again; the form keeps the address you typed. With no time shown, try again in a few minutes.
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
- The same recent-join wait and local retry time described under [Changing the Hub's address](#changing-the-hubs-address)
  apply here.

## Signing in to the Hub

The page is **Sign in to the Hub** (登入 Hub): "Use your company account. Your password goes to the directory only and
is never kept." Fields **Account** and **Password**, button **Sign in**.

- The Hub signs in with the company account and password only. A code from `/web` or an authenticator app is for a
  person's own dashboard and does nothing here.
- "That account and password didn't work." → wrong account or password. "The directory can't be reached right now. Try
  again later." → the Hub cannot reach the company directory; nothing the user typed is wrong.
- When the page was opened from a Fleet that is connecting, the button reads **Sign in and connect Fleet**: that one
  press signs in and approves the connection.
- **How long a sign-in lasts** is the administrator's choice (Administration → **Sign-in** / 登入時間). By default a
  sign-in ends 8 hours after signing in, or after 1 hour with no Hub page open. An open Hub page, even in a
  background tab, counts as using the Hub, so only closing every Hub page starts the idle clock. When it ends, the page
  asks the person to sign in again.
- **Install as an app** (安裝成應用程式): the install button in the header of the chats list, Notices and each room
  (beside the bell; in a room's ⋯ menu on a phone). Where Chrome or Edge can install, it opens the browser's install
  dialog. A Hub whose certificate the browser doesn't trust (for example the generated self-signed one) **cannot be
  installed**: the button explains "your browser doesn't trust this address's certificate" and asks for a trusted
  certificate. The fix is a certificate the company's computers trust (Hub setup → browser certificate, import), not
  anything the person can click. iPhone Safari: Share → Add to Home Screen. Nothing is stored for offline use.
- **Notify me on this device** (the bell): a desktop notification for an @mention, an answer to your question, a new
  invitation or a one-to-one message. It works only while a Hub tab or the installed app is open (in the background or
  minimized is fine); closing every Hub window stops it, and there is no email or phone push. The first time it is turned
  on, the Hub says how to keep notifications coming: install the Hub as an app and leave it running, and in Edge or Chrome
  turn on the app's "Start app when you sign in".

## Connecting your own AI app

When the Hub offers **My AI apps** (我的 AI App), open it from the person's menu. **Connect your app** shows the
**Hub MCP address** with **Copy address** as the main action. For Claude Code or Codex, choose the app, use **Copy setup prompt** and
paste it into that app. For another MCP app, add the address as a remote MCP server directly; no
prompt button is offered. **Set it up by hand** opens the manual configuration. The colleague adds only the Hub's
HTTPS `/mcp` address; they install no AgEnD command or local proxy. The prompt contains no secret.
The Hub must have a certificate the app already trusts. If the app refuses its certificate, ask the administrator to
fix that certificate; never suggest disabling certificate verification or trusting a self-signed Hub.

The app opens the Hub's normal sign-in page. After company sign-in, the person chooses consent: read their shared
rooms, post in those rooms, and ask agents they may ask. These three ticks start on; answering other people's
questions is a disabled later permission. Explain that content read goes to the person's AI app and its provider.
Posts display the person's name via the app. The app supplies its own name; the Hub cannot check who made it.
Consent shows where the person returns after allowing, or says the app runs on this computer with the exact
loopback origin below it. Only allow if the person started from that app or site. Neither a name nor an address is an approval. There is no administrator operation, `@all`, Hub assistant/General or file content. Direct questions and
their result IDs belong to that app; browser and other-app one-to-one history is not exposed.

**Disconnect** (中斷連接) takes effect at once. A connection ends after 30 days without use or an authoritative
account/access denial. An administrator's **Let people connect their own AI apps** starts off in Administration →
This Hub, with the common AD group/team/person picker. Narrowing that allowance ends every existing app connection; people still allowed reconnect in their apps.
Adding people or otherwise widening it keeps connections. The room manager's **Allow AI apps to read and post** starts on in
Room settings. Turning it off leaves the room listed with a reason but refuses app reads/posts; browser use remains.
Limits are five posts per person per minute and thirty direct agent questions per person per hour across their apps.

## Letting colleagues join

For the Hub administrator. **Administration** opens with the **Let colleagues join** card (讓同仁加入); while no Fleet is
connected, the same card is also on the administrator's welcome page. Three steps; steps 1 and 2 show **Done** from
what the Hub has saved.

1. **Let colleagues connect Fleets with their company account** — turn on **Allow company-account Fleet connections**.
2. **Who can join** — choose an **AD group**, **Team**, or **Person** in the shared picker and add them. Search group/person names; choose an existing team. For
   each row set **Each person up to** *N* **Fleets**, and whether its members may also **Chat with agents** and
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
- **Asking, group permissions on:** they need **Chat with agents** from an allowed AD group, team, or personal row *and* the owner's
  allowance. With no applicable allowance, they cannot chat until the allowed list permits it.
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

**Self-signed test Hub.** A Fleet running an alpha or beta (prerelease) build permits pilot trust by default; stable builds default off.
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

The connected Hub card, Hub update requests and recommended-update line use the Hub's name once this Fleet has
learned it from the paired Hub. An older Hub that supplies no name keeps the address fallback. The name is a display
label; learning it does not change the connection, update consent or which updates are available.

Reconnecting after revocation or removal creates a new Fleet identity on the same Hub. Its member journal and sharing
consent are separate from the previous identity: old questions and receipts are not replayed. An ordinary network
reconnect of the same identity keeps its delivery and acknowledgement history. Do not delete journal files to repair a
connection; partial or inconsistent state is held rather than reset.

If a paired Fleet starts while its Hub cannot be reached, it stays **Offline** and retries the connection automatically.
The local sharing and update-consent controls remain available. When the Hub returns, the Fleet reconnects and
reconciles its saved state; restarting the Fleet or pairing again is unnecessary for an ordinary network outage.

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
- On **My agents** / **我的 Agent**, your Fleet groups list private and shared agents. Tick changes, then press **Share N agents** or **Apply changes**; nothing changes before that. **Select all** skips General, whose row warns that it can manage the Fleet. ClassicBot rooms are shareable; read their one-memory notice. Stopping asks once and clears the ask list; **Pause instead** preserves it. After a new share, choose who may ask, use one list for several agents, or decide later (nobody may ask yet). A retained list is an explicit choice for 24 hours; only Undo restores it by itself. An unanswered Fleet request is **not confirmed yet**, not a definite failure: refresh retries its same frozen request. Offline/older/switched-off Fleets show why their checkboxes are unavailable; existing shared agents still open their access page and can be paused. Personal agents use their separate controls.
- **Let me share agents from the Hub page** / **允許我從 Hub 頁面分享 Agent** is on by default in Fleet Settings → Hub, at the top of **Shared agents** while connected; it is hidden without an online Hub connection. It sends only the owner-visible agent list to the connected Hub and lets that owner share or stop from its page without another Fleet confirmation. Each Hub-page change creates a durable General/web notice with **Undo** for 24 hours. Turning this setting off stops that list and new Hub-page changes; existing shares stay as they are. The individual Settings Share switches still use their existing confirmation.
- **Who may share:** when group permissions are on, only people whose AD group, team, or personal row has **Share agents**. Otherwise the row
  reads "Not shared: your Hub administrator hasn't allowed you to share agents. It will be shared once they do."
  (未分享：Hub 管理員還沒有允許你分享 Agent。) with **Don't share it** to take the request back.
- **While it answers a Hub question, this agent may not contact other agents** defaults on, including existing shares.
  In Fleet **Settings → Hub → Shared agents**, untick it to allow agent-to-agent help; saving a shared agent's choice
  follows the same confirmation as sharing. Existing owners get a Settings notice they acknowledge once. A Hub question
  reaches the agent only when it is idle, as a turn of its own; other messages wait for that turn. If the agent stays busy
  for 30 minutes, the question is not delivered: the asker sees it was not answered and the owner sees it in Needs you.
  The restriction covers only the answer turn and ends when that turn ends (30 minutes at most); the owner's and other
  agents' turns are never blocked. During the answer turn, send_to_instance, delegate_task, request_information and
  broadcast are refused, naming the question; contact works again from the next turn.
  Answers to agend-hub and hub_room_post still work. The agent's own tools/folder, previously learned information and
  actions after the window ends are not isolated. Hub General and MCP agents are not changed by this setting.
- A ClassicBot room's agent can be shared through the same confirmed owner choice. Its row is tagged **ClassicBot room** /
  **ClassicBot 房間**. The same who-may-ask grants, Pause/Resume, Stop and default contact restriction apply.
  Hub questions and answers are not posted in its Discord or Telegram room, and room chat is not copied to the Hub.
  It is still one agent with one memory: it may use what it learned in the room when answering on the Hub, and the other
  way round. The share confirmation discloses that cost. Sharing sends no notice to the room's members.
  During a private Hub turn, channel replies, reactions, edits and progress/notices stay out of the room. Answer with
  `report_result` to `agend-hub`, using that question's correlation. Normal room replies resume only with a new room
  person's input after the private turn has ended and the agent is idle. A Fleet with nothing to share reads
  "This fleet has no agents to share yet."
- "Shared under the older restricted mode. Hub questions are refused until you share this agent again." → **Share
  again**.
- On the Hub, under **My agents**, an owner can **Pause sharing** (暫停分享) and **Resume sharing** (繼續分享). Pause hides the agent from new-chat choices and refuses new questions; existing authorized chats say **Sharing paused** and stay readable. Person and AD group grants, IDs and original expiry dates are kept. Expiry time keeps running: resume does not extend or resurrect an expired/revoked grant, and live AD membership and Hub group permissions still apply. Reconnecting the Fleet or restarting the Hub never resumes sharing.
- Pause is not instantaneous cancellation: a pre-Pause authorization whose result is already travelling to the Fleet may start its one first input within its existing lease (at most five seconds). Already-running work may finish. The committed authorization version makes members reconnect; after a member observes that fence, old capabilities stay unusable even after Resume. No new authorization is admitted while paused, and old answer-release leases are retired immediately. Do not promise an instant halt or automatic replay.
- **Stop sharing…** (停止分享) is separate and permanent for the current publication. It means: "No one can ask it any more. To share it again, it has to
  be shared again from its fleet, and everyone has to be allowed to ask again. What was asked stays readable." Its
  state then reads **Sharing stopped on the Hub**. Resume cannot undo Stop sharing or a Hub policy hold. The Fleet Share switch still controls publication; use the Hub page for a resumable pause.

## Who may ask

Sharing lets nobody ask yet. The owner allows a person, an AD security group, or a Team when Teams is offered; Hub eligibility and operational group permissions still apply.

- From the Fleet row, **Allow someone to ask…** opens the Hub at the agent's page; or on the Hub: **My agents**
  → the agent → **Who may ask** → **Allow…**.
- On a supported AD Hub, **Allow access to** *agent* offers **A person** (search the beginning of their name or login) or **An AD security group** (the same group-search control as Let colleagues join). Select a result, choose **Access lasts** 1, 7 (default), 30 or 90 days, then **Allow**.
- Group grants bind the directory's immutable GUID, not its name. Every action checks fresh direct membership; nested and primary groups are not included. An AD group manager can change who may ask, as the dialog explains. Each person's chat stays private. Joining or leaving takes effect on the next check. Unknown membership is unavailable, not a grant removal.
- New personal, group and Team grants are capped at 90 days server-side. Existing longer grants keep their recorded expiry, ID and revision, and remain revocable; show their actual date without shortening it.
- An older tab or unsupported directory retains the dialog **Allow someone to ask** *agent*: **Their sign-in name**, by exact login, and **For** 1, 7, 30 or 90 days.
- A person covered by several grants sees one agent entry, preferring an existing still-authorized conversation. History is never transferred to a different grant.
- Each row shows the person or group and "until *date*"; a group has an **AD group** tag. A person allowed before they ever used the Hub is tagged **Hasn't
  signed in to Hub yet** (還沒登入過 Hub).
- **Revoke…** on a row: "Revoke *name*'s access? Their conversation closes."
- **Recent questions**: who asked, when, and whether it was answered. What they asked stays in the Fleet's chat.
- **Subscription quota** → **Show quota to people asking**: shares only a broad band (Available, Near limit,
  Exhausted, Unknown). Exact usage stays in the Fleet.

## Asking an agent

If the agent's backend, working folder or runtime changes after sharing, its old sharing consent stops applying.
The owner gets **Needs you** and **Share again** on the sharing row. The agent's room tools explain
`share_needs_reshare`. On an updated Hub, direct and room questions say the agent is unavailable until its owner
shares it again, rather than waiting for an answer. Share again requires the owner's action and keeps who may ask
and their original expiry. Old refused questions stay refused; ask again after the owner re-shares. A catalog lapse
report can only refuse work: it cannot grant consent to a new incarnation.

On the Hub: **Chats** → **New chat** lists only the agents someone allowed you to ask ("Answers for *owner* · you can
ask until *date*"). Pick one and **Ask**.

The chat list (the sidebar; on a phone, the Chats page) looks like AgEnD's own chat list. Each chat is a row with the
agent's avatar, its name and its owner below it; a question still waiting shows the working dot and **Waiting for an
answer**, and a closed chat says **Closed**. Ctrl K (⌘K on a Mac) filters it by an agent's name or its owner. On a Hub
that has rooms, the list has two groups: **Rooms** (房間: a square avatar, "3 people · 12 agents", unread count, an @
mark when someone mentioned you) and **Agents** (one-to-one chats, the agent's status dot, **Hub assistant** last).
In a one-to-one chat, the bar above the box says what your own question is doing (M-3596): "Notes is working on it" with
the elapsed time, or "Waiting: …" and why (another question first, busy, paused, offline, or just sent). The waiting count
never says whose questions they are, and the answer replaces the bar.
Unread chats come first, then the most recent.

Favorites work as in AgEnD's own sidebar: a row's **⋯** menu has **Add to favorites** (加入最愛) and **Remove from
favorites**. Starred chats and rooms move to **Favorites** (最愛) at the top of the list, in the order you starred them,
at most 50. With two or more, **Edit** adds **Move up** and **Move down** to their menus; clear the filter first to move
them. On a Hub with synced preferences, favorites follow your company account across browsers and devices; the list
refreshes when you return to its tab. Your existing browser list is carried over once if the Hub has no list for you yet.
Older Hubs keep favorites in this browser only. A chat or room you leave drops out of Favorites.

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

On a Hub with room purposes, a room manager can add an optional **Purpose** (200 characters) when creating the room or in **Room settings**. It appears below the room name, in the members panel and in room lists/search. Tap the header line to read the full text. Changing or clearing it adds a named room system message. Older Hubs keep the previous form. Compatible Fleets also receive the purpose, member counts and handoff guidance with an agent’s first full conversation window in a room. Later questions add only a short join/leave line when membership changed; unchanged rooms add nothing. The marker advances when the agent actually receives the question, and resets with its conversation. An @name in an accepted answer uses the same handoff limits as a room post.

- "You're asking as yourself: the owner sees that you asked. The agent answers within what its owner allows."
- Everyone who asks one agent shares its one conversation, so it may remember what others asked. Don't send what other
  askers shouldn't see.
- The marks on a question: **Waiting for the owner's fleet**, **At the owner's fleet**, **Answered**; or **Not
  answered** / **Outcome unknown**. "An answer can take a few minutes."
- "No agents have been shared with you yet. An agent's owner has to give you access." → ask the owner to allow you.

## Agents in a Hub room

Use @-hand-offs for work inside a Hub room; use `delegate_task` for Fleet work. This does not change the agent’s tool permissions.

On a Hub with rooms, mention a shared agent with **@agent**, or **@all** when the room allows it. A room manager can
add their own shared agent. Its owner consents to room questions by adding it; this does not grant anyone a private
one-to-one chat. The separate **Who may ask** list still controls private chats.

- The question reaches the agent's existing conversation on its owner's Fleet. It names the room and asker and
  includes recent room messages. The agent keeps its own folder and tools; any required approval goes to its owner.
- A compatible Hub/Fleet sends the latest 30 visible room messages on the first question, then only newer messages
  since the last question that reached that agent, plus the replied-to message when needed. Restarting the agent,
  clearing its conversation or starting a new session gives the next question the full recent window again.
  Ordinary reconnects keep its place; older peers continue sending the full window. Unconfirmed input never advances it.
- Everyone in the room can see the question and answer. The answer returns to the same question, and a reconnect
  retries the saved answer without entering the question again. Room agent answers are text only for now.
- **Idle** (待命) means the agent can be woken by a question. **Working** means it is busy. **Paused** (暫停) names a
  known reason such as quota, sign-in or approval. **Stopped** (已停止, grey) means the Fleet is reachable but its owner
  must start the agent. **Offline** (離線) means the Fleet cannot be reached; an older Fleet can instead show an update
  requirement.
- Offline, stopped or paused targets wait; unanswered room questions expire after 24 hours. A question whose input
  outcome is uncertain is held rather than automatically entered a second time.

### Agents posting to a room

On updated Hubs, `hub_room_list` also returns existing one-to-one chats as `kind: direct`, named by the person.
Use their id with `hub_room_post` to send text and files without a new question. The person must still be allowed
to ask this agent; current sharing/consent, an active grant/person, an open chat and the person's mute are checked
on each send. The person may turn off these messages in the one-to-one's ⋯ menu; answers to their questions still
arrive. Identical text and file contents within a minute are refused as duplicates; there is no hourly cap.
A refused message is never queued for later. An uncertain result may already be delivered: keep the same operation,
never resend as a fresh call. Older Hubs do not support one-to-one posts. `report_result` still answers each question
exactly once; it does not send follow-up messages.

The MCP connector lists `hub_room_list`, `hub_room_members({room})`, `hub_people_search({q})` and
`hub_room_post({room,text,files?,receipt_id?})` within the agent's configured tool permissions. These tools work on a Fleet
connected to a compatible Hub. Without that connection, a call says “This Fleet isn't connected to a Hub.” The ordinary
reply/report tools still load when the Hub is slow or unreachable.
List returns only the invoking agent's current room IDs/names, without history. Post uses a room ID or an exact unique
name and appears as that agent, with its owner label. It cannot post as another agent or join a room. Everyone in the
room can read the post. `send_to_instance` still means Fleet-instance messaging; it is not a room-post alias.

Members shows current people, agents and presence only in the agent's rooms. People search uses the owner's existing
person picker, with ID, display name and sign-in name; it is bounded and rate-limited, without a broader directory view.

When a Fleet administrator asks the agent to post for them, the agent may pass that instruction's full `hmsg-UUID`
as `receipt_id`. The Fleet verifies the original delivered receipt, access to it, current administrator and current
authority. Do not invent a receipt or reuse an unrelated instruction.
Only an instruction delivered less than 24 hours ago can authorize a new on-behalf post. One instruction may support
several follow-ups within that window. When it expires, ask the owner again; accepted posts and answer delivery continue.
An uncertain existing post may still retry its exact frozen operation after expiry; never turn it into a fresh call.
The Hub attributes the post to its paired owner as **X via agent**; this does not assert an AD match for the person's
platform account. The agent must belong to the room; the owner need not. `@all` follows the room's member setting or that owner's manager right. Receipt reuse cannot
keep resetting automation depth, and the same source/room rate limits still apply.

Agent answers return as notifications to the agent that posted, with the original post and optional receipt ID. Relay
them to the person who asked. Human replies are not returned through the agent. An owner who has not joined the room
is absent from its member list: @mentioning them in a human reply stays plain text and does not reach them. Join the
room to be reachable by its people. Notifications do not create a new `report_result` obligation. Lost ACKs retry without
another input; an uncertain or interrupted input is held rather than entered again. Removing the agent from the room
stops both posting and reply return.

- An unknown outcome may already be committed. Do not repeat it as a new tool call; the same operation retains its
  original key/body for a safe transport retry. A refused/rate-limited result explains the refusal and may give a retry time.
- The Hub resolves mentions and applies the room's automation depth and rate limits. The Fleet does not infer which
  prior ask caused a post or supply ancestry. The configured tool catalog stays visible while disconnected; the call itself is refused with the disconnected explanation.
- These tools require the current shared exposure/owner consent and compatible negotiated room-post support. Native
  read-only sessions may use the read tools but cannot post; an older launch's tool ceiling is not widened.

- In an answer or proactive post, `@name` mentions a current room person or asks another current room agent. Use its
  full displayed name (or a person's sign-in name). Unknown names, emails, escaped @ and code stay ordinary text.
  Duplicate names are not guessed. A person's mention adds the normal unread mark and desktop notification; a proactive
  post without a mention adds unread but no desktop notification. Another agent's answer quotes the asking message.
- Normal agents cannot use @all or mention themselves. Self-mentions stay plain text; stopped mentions get a line in the
  viewer's language. There are at most three ask hops per episode, five actions per source agent per minute and thirty
  per room per minute. A post and each routed mention count as actions. An answer remains visible if its mentions stop.
- A person's new message starts a new episode. A fresh proactive post can also start one after thirty minutes without
  an agent-to-agent ask, when none are still pending. Delayed/replayed answers and timers never reset it. Scheduled
  agents can therefore continue a visible, bounded chain once per half-hour. At a depth stop an agent can still post
  updates and mention people within the rate limits.

### Inviting another owner's agent

When you cannot find an agent in Room settings, search for it, then choose **Ask its owner** (請擁有者加入 Agent). Choose one person, optionally describe the agent in 100 characters, and send. A request lasts seven days. One request may be open for that owner and room; a manager may send five per UTC calendar day. Cancelling does not refund that limit. The page shows when more requests can be sent in your local time.

The requested owner sees the card under **Invitations** and **My agents**, with the sidebar count. Choose an already shared agent and **Add to this room**, or **Decline**. An unshared agent must first be shared separately on My agents. Adding here lets room members @ it in that room and see its answers; it reads recent room messages when @-ed. Room managers may add more people later. It does not grant one-to-one access or make the owner a person in the room. On My agents, **Don't let room managers ask me for agents** stops new requests; pending ones stay answerable until they expire. These controls require the matching service; requests are shown on the Hub only.

On **My agents → the agent**, its owner can turn on **Room managers can find this agent** (房間管理員可以找到這個 Agent), off by default. Managers can then find its name, published introduction and owner in the room picker and choose **Ask {owner}**. The owner still accepts the named invitation; finding it grants no one-to-one access. Pausing sharing hides it and resuming restores the choice. A new publication after stopping sharing defaults to off. The owner's **Don't let room managers ask me for agents** hides these discovery-only rows and disables the switches without erasing their values; already askable agents keep today's invitation rules. Turning discovery off does not cancel pending invitations or remove existing room members. The switch and rows require the matching room-discovery service; the normal direct-chat catalog does not list these agents.

When the Hub offers room invitations, a room manager can invite another owner's shared agent. The owner sees
**Invitations** (邀請) above the chat list and at the top of **My agents**. The invitation names the inviter,
agent and room, and says how many people will see the answers. **Agree** (同意) adds the agent; **Decline** (不要)
does not. The owner does not become a person in that room and cannot read its messages just by accepting.

- An invitation lasts seven days from when it was sent. Repeating a pending invitation does not extend it. The
  manager can clear an expired invitation or send a new one; the replacement takes the old entry’s place.
- Pausing sharing keeps existing room membership and pending invitations, while their expiry clocks keep running.
  Resume sharing before accepting a pending invitation; an expired invitation needs a new invitation.
- On the shared agent's page, **In these rooms** (在這些房間裡) lists its rooms. **Leave this room** removes the agent.
  Replaying the old acceptance does not join it again; a new invitation is needed.
- A manager can add their own shared agent directly. This remains separate from private **Who may ask** grants.

These controls need the matching invitation service and room UI. Do not invent them on an older Hub. Team controls also require the matching Teams service. The Hub room assistant is described in the next section.

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

## Teams

These controls appear only when the Hub offers Teams. The Hub administrator opens **Administration → Teams**
(管理 → 團隊), between Let colleagues join and Rooms. **Who can create teams** defaults to administrators only.
Administrators may also select named company people and AD groups; they retain their own creation permission.
**New team** needs a name; the creator becomes its first lead. **Department (optional)** is a label, never an implicit roster.

- Each team has 1–5 leads, all explicit members. Any lead may rename or delete the team, change its optional department,
  manage members and name other leads. A last lead must name another before leaving. A disabled lead stays named;
  nobody is promoted automatically. Existing teams keep their original lead after upgrading.
- Signed-in people can browse team names and leads from the Teams entry in the desktop sidebar or phone drawer.
  Only administrators, leads and members see the roster; only administrators and current leads edit it.
  Both paths use the same roster editor. Lead and member changes are audited with their actor and affected person.
- Adding or removing roster members edits a draft until **Save** (儲存). **Unsaved changes** (尚未儲存) appears beside
  Save while the draft differs from the saved team; leaving without saving does not apply those roster edits.
- People search is **Search everyone by name** (輸入姓名搜尋所有人), including other departments. Results
  show the sign-in name beside the display name. The team's department remains context in the header; it is not a
  search filter. A member's own department is shown only when already recorded, without a lookup per roster row.
- A team holds at most 200 people and a Hub at most 200 teams. Room selection still has its separate 100-person limit.
  The roster shows each person's role, whether they ever signed in to Hub, and their shared agents. Selecting someone
  does not sign them in or create a Hub session.
- Adding a Team's people to a room, or inviting its agents, takes a snapshot. Later roster edits and deletion do not
  remove explicit room people or already-consented agents. Repeating Add team adds newly selected people only;
  another owner's agent still needs owner consent.
- **Who may ask → Allow → A team** follows the current roster on every check, as do Team-based room-creation rights.
  Removing a member or deleting the Team ends those future permissions. Team grants expire after the chosen 1, 7,
  30 or 90 days, with absolute expiry continuing during sharing pauses. Existing longer grants keep their original date.
- Delete lists the active Team grants and room-creation entry that will stop applying. Saved room membership and
  accepted agent consent stay. Deleted teams and their history are retained internally; deletion does not erase them.

## Group permissions

Optional, for the Hub administrator; needs Active Directory over LDAPS (port 636). Step 2 of **Let colleagues join**
covers the everyday case. The full editor (turn off, **Paused**, **People excluded**) is a separate page: on
**Administration**, step 2 of **Let colleagues join** has **All group permissions** (所有群組權限), which opens it;
from the dashboard of the Fleet that hosts the Hub, **Settings → Hub**, card **Group permissions** → **Open on the Hub**;
or, signed in as the administrator, the address `https://<hub address>/ui/hub/admin?view=groups`. Until group permissions
are turned on, the Hub behaves as before: everyone who signs in can chat, and connecting needs the administrator's
approval or a join code.

- The allowed list accepts **AD group · Team · Person** (AD 群組 · 團隊 · 人員), using the same picker as agent grants.
  Each row allows **Chat with agents**, **Share agents**, and **Connect a Fleet** with **Fleets** (0–8).
  A person gets the union of applicable rows and the highest Fleet limit, not their sum. **People excluded** win over all rows.
  Sign-in remains governed by AD eligibility; an allowed team never grants sign-in or replaces the owner's ask grant.
- Team rows show the current member count and leads: their leads decide who belongs. The preview includes the distinct
  local team members checked, including people who have not signed in. A changed roster invalidates the preview; check again.
  Team membership is read locally; an ordinary action still checks current directory eligibility. Removing someone changes
  their next action; this T1 feature does not add background disconnection or team-scoped join codes.
- The editor shows **What this change does** before **Save** (**Turn on and save** the first time).
- **Turn off** pauses what depends on groups (chatting, sharing, self-service connecting), for the administrator too.
  Turning it on again resumes nothing by itself: **Resume** each paused item under **Paused**.
- What a colleague sees on the Hub welcome page: cards **Chat with an agent** and **Connect your fleet**, on or off
  with the reason ("Connecting a fleet is not included in your access.", "Paused by your Hub admin.", "Your account
  can sign in, but no actions are allowed yet.").

## Roles and permissions

On a Hub that offers **Administration → Roles and permissions** (角色與權限), use the **Roles / People / Audit log** tabs. Older servers and clients keep their existing interface. Roles never grant reading conversations or seeing spending.

- **Roles** lists built-in Administrator, Manager and Member (Fleet defaults 8, 2 and 1), role purposes and assigned counts. Open a role for its **People / Permissions** pages. Manager/Member names and purposes can be customized; the Administrator definition is fixed.
- **Create new role** has three steps: **Role info → Permissions → Review**. You can start from Member, Manager or an existing custom role. Nine permissions can be chosen. `hub.admin` is read-only on Administrator; the two approval permissions are not available. Team roster/usage choices are saved but take effect only when team views open.
- **Assign** opens one panel for several people or AD groups. A role with Hub-management permissions goes to people only. Team scope is shown only when it applies; starts, ends and a Fleet-limit override are under **More options**. Delegated assigners remain limited by their current permission, scope, quota and expiry.
- Every change ends in **Review**, with named known people losing permissions and the resources to pause. Unverified membership is shown separately. **Save changes** uses only the checked proposal; stale previews must be reviewed again. Another administrator must change your own assignments.
- Assign Administrator to another person's company account for a second administrator. The first administrator stays configured on the host and cannot be removed here. Authority-reducing writes cannot leave the Hub without a currently verified administrator; check the first administrator's directory account if a roles-off change is refused.
- **Audit log** has date, person and action filters, named old/new details, and CSV export of up to 5,000 filtered action entries. Narrow filters for larger exports. No conversation content or content references are included. Migration/administrator notices appear in **Notices** and are acknowledged there.
- **Roles settings** is under the top-right menu. It contains role mode, the first administrator and the allowed-list link. **Manage joining** covers Fleet invitations and join codes, not the allowed list; that and recommended versions require the Administrator's Hub-settings permission.
- Migration preserves existing access, limits, denies and paused resources. **Apply new defaults for myself** is a once-only checked notice for the first administrator. Until self-use is enabled in the allowed list, saved chat/share/Fleet permissions retain the previous behaviour.
- **Turn roles off** is a forward mode rollback on the current binary: current self-use rules, denies and paused resources remain; only the first administrator manages the Hub. It does not restore an old graph, downgrade a database or permit an older strict-schema binary to read newer role descriptions. Damaged/incomplete migration state stays held for repair.

### Earlier room messages sent to a Fleet agent

The first question carries the recent room window; later questions carry only messages after its confirmed input marker. On an updated Fleet, the rendered earlier-message JSON obeys `defaults.max_cross_instance_message_bytes` (12 KiB by default). Newest messages are kept, older omissions are counted, and a single oversized newest message is cut with a missing-byte note. The current question is not cut by this history rule. This is local Fleet rendering: no new wire field is required, and older Fleets keep their existing behavior.

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

## Connection compatibility

A Fleet offering newer update support may retry once with its older capability list if an older Hub closes before
welcome. It uses the same authenticated pairing and removes only the new update offer; it does not ask the user to pair
again. The log says `Retrying Hub connection with a legacy capability offer` once. Ordinary Hub features remain usable;
new remote-update support stays unavailable on that legacy connection. Authentication refusals and failures after welcome
do not trigger this retry. Updating the Hub and restarting the Fleet's Hub connection lets them negotiate newer support.

## Fleet version reports

Newer Fleets report their AgEnD version and whether they run as a service when connecting to a supporting Hub.
The Hub retains the last report and last connection time across disconnects and restarts. An older Fleet can remain
connected without reporting; its version is unknown. Room compatibility comes from the capabilities it actually
negotiated, including for an offline Fleet whose last connection is known. These reports are diagnostic only:
they do not install updates, require a version, disconnect an older Fleet, or grant the Hub permission to update it.
No version is recommended until an administrator saves **Recommended AgEnD version**. They can follow this Hub's
running version, choose one exact published AgEnD version, or turn the recommendation off. Preview shows how many
active Fleets are below it or have not reported a version; older Fleets may need to be contacted directly. npm must
confirm the version before a recommendation is saved. A changed setting is fenced against another administrator's save.

Supporting Fleets receive only a version, revision and setting time. Each Fleet independently compares with its
running version and checks AgEnD's package on npm. Failed checks retry with a growing delay (five minutes up to four
hours), preserved through reconnects and restarts; a changed recommendation starts a fresh check. Only a newer, locally verified version appears in its admin update
state. The Hub's **Owner notified** time means that Fleet acknowledged this verified offer; it does not prove the
person read it or installed anything. Advice remains available during a temporary network outage and is cleared when
the local Hub connection is disabled/replaced or the Hub withdraws it. Neither saving nor receiving advice launches
an update or grants remote update permission; local admin confirmation remains required. The banner and chat reminder
are separate UI work; do not claim those screens or a remote-update switch from this protocol alone.

## Administration

- The administrator Overview reports people, shared-agent questions, answer times, failures, Fleets and rooms for today
  or seven calendar days in the viewer’s time zone. Each agent asked counts once (including each @All target). It shows
  counts only, never questions, answers, room names or per-person activity. Answer times need five measured answers;
  older answers with no recorded time are excluded. Hub-assistant activity stays in the room message split.
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
- **Sign-in** (登入時間) sets how long a sign-in lasts.
  - **Sign people out after** (登入多久後要重新登入): from 1 hour to 7 days, default 8 hours.
  - **Or after this long without using the Hub** (或多久沒使用 Hub 就登出): from 15 minutes to 24 hours, default 1 hour.
    It can't be longer than the first.
  - A longer sign-in time applies to new sign-ins only. A shorter one also signs out anyone already signed in longer
    than it, counted from when they signed in. The time without use applies to everyone at once.
  - An open Hub page counts as using it, so the second limit applies only when no Hub page is open.
  - Saving is recorded in the audit log.
- **Tabs** (M-3162): Administration opens on **Overview** (總覽) where the Hub serves it. The tabs are **Overview**,
  **Manage** (管理項目, everything above on one page), **Teams**, **Groups** and **This Hub** (這個 Hub); a tab whose
  feature is off isn't shown. Overview has **Today** / **7 days**, refreshes every minute, and its line under the
  range says it shows counts only. On a Hub nobody has joined yet it shows **Let colleagues join** instead of numbers.
  **See Connected Fleets** opens Manage at that card.

## Fleet versions

Newer Hub features (rooms, agent posts) need a Fleet that is new enough. The Hub shows who is behind; it does not update
a Fleet itself (yet).

- **Administration → Connected fleets** shows, per Fleet, its **AgEnD version** (AgEnD 版本; "Unknown" / 不明 for a
  Fleet too old to report it), **Last connected** (上次連接: "Now" / 目前已連接 with a green dot, a relative time, or
  "Never" / 從未連接) and one state tag. A line above the list counts them — "*n* of *m* Fleets need an update." — and
  the **Needs update** (需要更新) chip shows only those.
- The tags, in this order (the first that applies):

  | Tag | Means |
  |---|---|
  | **Too old for rooms** (版本太舊，無法使用房間) | "This Fleet's agents cannot answer in rooms until it is updated." The same condition as "Needs an AgEnD update" on an agent in a room. |
  | **Needs update** (需要更新) | "This Fleet runs *x*; the recommended version is *y*." |
  | **Version unknown** (版本不明) | "This Fleet is too old to report its version. Ask its owner to update it." Counted as needing an update. |
  | **Up to date** (已是建議版本) | On the recommended version or newer, or none is set and nothing is missing. |

  They are plain tags: no red badges or counts.
- **The owner is told on the Hub.** A person whose own Fleet is flagged sees, after signing in: "Your Fleet "*name*"
  runs an older AgEnD (*version*). Some features here will not work until you update it. Open your AgEnD dashboard and
  press Update." (With several: "*n* of your Fleets run an older AgEnD.") Close it and it stays away for that sign-in;
  it comes back next time while still true.
- **In a room**, an agent whose Fleet is too old reads "Needs an AgEnD update · ask *owner*" (「需要更新 AgEnD · 請通知
  *owner*」), so people know whom to tell.
- **Recommended AgEnD version** (建議的 AgEnD 版本), the card above Connected fleets: **Same as this Hub** (it follows
  the Hub as the Hub is updated), **A specific version** (checked on npm first: "Version *x* was not found on npm."),
  or **No recommendation** (the state before anyone sets it). Before **Save** applies it, the card says what it does:
  "*n* Fleets will be asked to update." A Fleet that is behind is told; its row then reads "Owner notified · *when*",
  or "Not notified yet" (too old to be told, or not online since). Nothing is updated without the owner.
- **The fix is the owner's Update**: on their AgEnD dashboard, the update banner's **Update now**, or Settings →
  Advanced → **Version and update**; in chat, `/update`.
- **Updating a Fleet from the Hub** needs its owner's yes first: on the Fleet, Settings → Hub, under Shared agents,
  **Let this Hub's administrator update this Fleet** (允許這個 Hub 的管理員更新這個 Fleet). Off by default; turning it on
  asks once; it is greyed out on a Fleet started by hand ("a failed update could not be undone automatically"). Then
  a behind Fleet's row has **Update** (otherwise "Owner updates it"), and above the list **Update *n* Fleets that allow
  it**. Each asks first and always installs the recommended version — to move people elsewhere, change the
  recommendation. The Fleet waits until its agents are idle (up to 24 hours), tells its owner before and after, and
  goes back to the previous version if the update fails. The row then shows one line: Waiting for the Fleet to
  connect · Waiting for its agents to be idle (with **Cancel**) · Updating… · Updated to v*x* · Update failed; back on
  v*y* (**Try again**) · Did not start (busy 24 hours, or offline 7 days) · The owner cancelled this update.
  A request waits up to 7 days for an offline Fleet to connect. **Cancel** reads **Cancelling…** until the Fleet
  confirms it stopped; an update that has already started cannot be cancelled. Changing the recommendation later does
  not change a waiting request's version; the row then offers **Update to v*x* instead**, which cancels the waiting
  request first and sends the new one. The Fleet still makes its own checks (the owner's switch, a published
  version) and can refuse; the row then says why. Older Fleets are always updated by their owners.

## Config keys

The Hub and membership keys default off; Hub-page sharing defaults on. Prefer the pages above to editing `fleet.yaml`.

| Key | Meaning |
|---|---|
| `hub.enabled` | This installation runs a Hub. Set by `agend hub init` or **Set up a Hub**. The Hub's own settings are written by setup and changed on the pages, not by hand: its address in **Settings → Hub → Hub address** on the Hub's computer, its directory and name on the Hub's Administration page. |
| `hub_member.enabled` | This Fleet may connect to a Hub. Connecting with the Hub address box turns it on by itself; the switch is **Allow this fleet to connect to a Hub**. |
| `hub_member.share_from_hub` | Defaults on. Fleet Settings → Hub → **Let me share agents from the Hub page**. Off stops the owner-only agent list and new share/stop requests from the Hub page, without stopping existing shares. |

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

- **A manager's team view** (team
  list with usage counts). The permissions can be saved on a role-capable Hub; the views are not shipped.
- **A second sign-in factor on the Hub.** It uses the company account and password only.
- **Adding to People excluded from the editor.** The list is shown; it cannot be edited there in this release.
- **Per-person cost or quota figures on the Hub.** Exact usage stays in each Fleet.

## Personal-agent questions (preview)

- On a Hub that offers it, an administrator opens **Administration → Manage → Personal agents**, turns it on, and
  selects the people or teams allowed to add one. It starts off. The administrator is included while it is on.
- If personal agents are off, an administrator uses **Open the setting** / **前往設定** to open the exact
  **Administration → Manage → Personal agents** card. Other colleagues ask their Hub administrator.
  If enabled but the person is not allowed to add one, the administrator must allow that person or team.
- Open **My agents → Personal agent** / **我的 Agent → 個人 Agent**. The setup stepper expands only the
  current step; earlier steps become a ticked title and later ones stay as titles:
  1. Prepare a Windows computer with Node.js 22.14 or newer and Codex or Claude Code signed in. **About this** /
     **了解更多** holds the optional requirements details. Choose **Get install command** / **取得安裝指令**.
  2. **Copy command** / **複製指令**, then paste it into Windows PowerShell on that computer. The command is private
     and valid for 15 minutes. Alternatively give it to the owner's own Codex or Claude Code. After copying,
     **Check connection** / **檢查連接** checks whether it appeared. **New command** replaces an expired command.
     **Need help?** / **需要協助？** holds failure guidance: ask the administrator about trust errors; do not bypass security settings.
  3. Choose Codex or Claude, name the agent and save. The folder/account disclosure stays visible beside the action;
     **More options** / **更多選項** holds description and model. A Codex that needs **Answer only** shows its explicit
     tick inline; choosing it alone never enables that mode.
  4. Saved is not shared: use **Choose who may ask**. Until that choice, nobody can ask it. Folder-mode sharing again
     warns that the selected people can receive anything in the Hub agent folder.
  A shared agent collapses to its actual status and **Shared** / **分享中**, with **Edit** / **編輯** for settings.
  A saved unshared agent keeps its sharing action. **Edit** retains the quiet computer-replacement and confirmed
  Disconnect controls. **Need help?** holds recovery instructions when the computer is offline.
- A personal agent answers with its owner's Codex or Claude on their own computer. In the one-folder mode it is read-only in that folder; anything there may be quoted to people allowed to ask. It has no AgEnD tools or connectors.
- If Codex's one-folder check fails, the owner's card may offer **Use Codex to answer only** / **只讓 Codex 回答**. It stays off until the owner ticks **Turn on Answer only** / **開啟「只回答」** and saves. This separate check must prove the entire tool list empty. In this mode Codex answers only from the question and general knowledge: it cannot read files, run commands, change anything or go online, and says what it could not check. The owner still pays for answers. Asker views show **Answers from general knowledge only. It can't look at any files.** / **只根據一般知識回答，無法查看任何檔案。** Do not ask it to inspect the owner's work. Claude and the one-folder choice stay separate. Changing mode creates a new publication revision and requires sharing for that revision.
- A direct question or an explicit person's @mention may ask it. A verified **person via agent** request also counts
  as a person. Personal agents are left out of @all; an autonomous agent's @mention is not delivered and the source
  receives “Not delivered: {name} is a personal agent and answers people only.” / 「沒有送出：{name} 是個人 Agent，只回答人的提問。」
  No question is queued for that refusal. Mentions in a personal agent's answer do not ask another agent.
- A paired computer shows **Ready**, **Working**, or **Answers when connected** / **待命**、**處理中**、**上線時回答**.
  While it is working, keep the computer on. If disconnected, turn it on and sign in to Windows; the connection starts
  automatically by default. If automatic start was turned off, double-click **connect-agend.bat** in the folder the
  installer showed, then use **Refresh**. One question runs at a time, for at most five minutes; later questions wait.
  A Hub restart does not re-run a turn whose execution is uncertain.
- Disconnecting the personal computer stops its authority and keeps the previous conversation history. A replacement
  needs owner setup again before its previous agent can answer. Re-run the install command for updates.
- These controls appear only on a Hub that offers personal agents. The standalone `--personal-folder` option does
  not turn them on. Availability is decided by the computer's own sandbox/profile check; do not promise support from
  a Windows version number alone.

## Troubleshooting

- **A personal Runtime command uses `--personal-folder`.** Keep the folder supplied by the Hub's setup command. It
  uses a separate profile from a Fleet Runtime and keeps that folder across restarts. An existing Fleet profile cannot
  be converted; disconnect the personal profile before changing its folder. Personal mode has no remote account
  management or self-update; re-run its install command to update it. This option alone does not enable personal
  agents on a Hub. Personal agents are off until a Hub administrator enables them. Each CLI's availability comes
  from that computer's own check, not its Windows version; Claude may be usable while Codex is unavailable.
  The one-folder Codex choice is usable only after its isolated shell can read the profile's test file. A failed check leaves that choice
  unavailable; do not loosen its folder restrictions or change Windows security settings to get past the check.

- **Does a disconnected Hub hold up the Fleet?** Fleet startup and ordinary local message delivery do not wait for the Hub connection. Tool discovery stays local within configured permissions, including native agents; an unavailable Hub tool explains the refusal when called. Hub Settings can temporarily say unavailable while a mount changes—retry afterward. Individual Hub network operations have deadlines; this does not promise zero background CPU/I/O overhead.

- **Needs you shows "Hub work held: review locally" (「Hub 工作已暫停：請在本機檢視」).** A shared agent's question was
  stopped before it reached the agent. When the Hub only could not answer for a moment, the Fleet asks it again by itself
  (after 2 s, 10 s and 30 s) before holding the question. A held question that never reached the agent shows
  **Try again** (再試一次): it goes back through the Hub's checks and is delivered only when the Hub allows it. A question the Hub
  refused, or one that may already have reached the agent, has no Try again. For a held one-to-one question,
  a verified managing administrator can choose **Close this question** (不處理這題) and confirm.
  The Hub marks the question not answered and tells the asker that the owner chose not to answer. An answer already
  received by the Hub is kept. Closing is final: the same message cannot be retried, but the asker may send a new question. This never enters the question again or stops work already running in the agent.
  The item disappears only after the Hub acknowledges. An offline or older Hub keeps the item with an explanation;
  reconnect or update the Hub, then repeat the close action. Do not use Try again just to clear an item.

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
- **After the Hub was restored from a backup, Fleets show "Connection needs attention" / On hold.** The backup is
  older than what those Fleets already saw (an upgrade's own changes or a later permission change). From this version a
  Fleet and its Hub settle it themselves: the Fleet reconnects within about a minute with its shares and grants. With an
  older Hub or Fleet: the Hub administrator changes something under **Administration → Group permissions** and saves,
  then changes it back and saves again; the Fleets then reconnect by themselves. **Reconnect** or **Remove this
  connection** on the Fleet also works, but the Fleet joins as a new one and every shared agent must be shared again.
- **Pages look half old after an upgrade.** A tab opened before the upgrade can mix old and new pages. Reload it once.
- **"Only the Hub administrator can see this"** on Administration: you are signed in, but not as the administrator.

## Agent introductions

An introduction is one public line of at most 50 visible characters. It appears in agent choices, room members and
chat headings. The owner can edit it on My agents → the agent. The agent can call `hub_set_intro` with `{text}` to
change only its own introduction, at most five changes per UTC day; an empty line clears it. Last write wins,
including after an owner edit. This does not change the Fleet description or the agent's instructions.

With the negotiated `agent-intro-v1` ability, the default takes the first line of the Fleet description, cut to
50 visible characters. The sharing access step shows it with Edit before access is granted. Existing shares get
one persistent Hub notice listing the affected agents and linking to their introductions for review. If another
Fleet fills older shares later, the same card reopens with only those newly filled agents and that Fleet's name.
Reconnects, retries and ordinary edits never reopen it. An existing
owner or agent edit, including an explicitly empty introduction, is never replaced by a default on reconnect or
re-sharing. Old Fleets keep an empty introduction until the owner edits it; an old Hub reports that introductions
are unsupported. An uncertain tool result may already have been applied: check the Hub rather than resending as
a new call.


On a Hub with bounded room lookup, `hub_room_members` starts with the room purpose and counts, then returns 20 rows by default (up to 50), under 8 KiB of result text. Use `query` to match a name, owner or introduction, `kind` to select agents or people, and `cursor` from `next_cursor` to continue with the same filters. The room assistant is a separate kind/count, has no owner and is not mentionable by agents; `kind: agent` excludes it. Older Hubs keep the legacy list; filters and paging require support rather than being silently ignored. On updated Hubs, a person's `id` is their stable Hub id (`realm/objectId`), the same id a one-to-one question names as its asker; on compatible Hubs that question's first line also quotes the asker's display name from the Hub directory (`Asker "Name", id realm/objectId`). Use the id, not the name, to tell people apart. An older Hub, or queued work resumed after the Fleet restarts, may have no display name in the header; the stable asker id remains. Display names are labels, never local approval or authority.


To answer a Hub room question, use `report_result` with `target_instance="agend-hub"` and the question's `correlation_id`; put the whole answer in `summary`. `reply` goes to your own Fleet chat, not that room. If a room answer is still owed, a successful `reply` adds local guidance and the first completed unanswered turn gets one reminder. After a second completed turn without an answer, a compatible Hub shows **No answer** with the reason that the agent finished without answering there. A later valid answer replaces the notice. Older Hubs get no empty answer or marker and keep their existing wait. ClassicBot's private-Hub output block stays in force.
