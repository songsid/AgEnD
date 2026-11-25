# Hub group permissions

中文版：[hub-group-permissions.zh-TW.md](hub-group-permissions.zh-TW.md)

> **Preview. Available from 2.4.0-beta.1, and off by default.** Group permissions let a Hub administrator decide, by Active Directory security group, what signed-in colleagues may do on the AgEnD Hub. Until an administrator turns them on, the Hub behaves as before.

Everyone in your directory can still **sign in** to the Hub. Group permissions decide what each person can **do** after signing in:

| Permission | What it lets a member do |
|---|---|
| **Chat with agents** | Ask the agents their owners have shared with them. The agent's owner still has to give each person access; the group permission alone opens nothing. |
| **Share agents** | Share new agents, or new versions of agents, from their own fleet on the Hub. Each share still needs the owner's own confirmation. |
| **Connect a fleet** | Pair their own AgEnD fleet through self-service, up to the **Fleets** number set for the group (0–8). With **Fleets** at 0, self-service is unavailable even though the box is ticked; explicit administrator approval remains available as described below. |

A person who is in several groups gets everything any of their groups allows, and the highest **Fleets** number among their groups that allow **Connect a fleet**. A person listed under **People excluded** is denied what they are excluded from: exclusions win over any group.

## 1. Set up access for a department (Hub administrator)

### Where the editor is

Group permissions need the Hub's directory to be **Active Directory over LDAPS (port 636)**. With any other directory the editor is read-only and says *"This Hub's directory can't be used for group permissions. Group permissions need Active Directory over LDAPS (port 636)."*

Only the Hub administrator can open it. Either:

- **On the Hub:** open the menu on your account in the sidebar (**Menu**), choose **Administration**, then, on the **Group permissions** card (tagged *Preview*), choose **Open group permissions**.
- **From your fleet's dashboard** (the fleet that hosts the Hub): **Settings → Fleet → Hub**, then, on the **Group permissions** card, choose **Open on the Hub**. It opens the Hub's editor in a new tab.

Someone who is not the Hub administrator sees *"Only the Hub administrator can see this"* on the Administration page instead. If the Hub is too old to have the editor, the link says *"Group permissions aren't available on this Hub yet. Update the Hub, then try again."*

### Add a group

1. In **Group (distinguished name)**, type the group's distinguished name, for example `CN=Hub-Members,OU=Groups,DC=example,DC=test`.
2. Choose **Add group**. The Hub looks the group up in your directory (*"Looking up the group…"*).

The group must be a **security group** that exists in the directory. The editor says so plainly if it is not: *"No such group in the directory."*, *"That is not a security group."*, *"That is not a distinguished name."*, or *"That group, team or person is already listed."*

A new group starts with **Chat with agents** only, and **Fleets** set to 1. Tick **Share agents** or **Connect a fleet** as needed. **Fleets** (how many fleets each member may connect, 0–8) can only be changed while **Connect a fleet** is ticked. **Remove** takes a group off the list.

Nothing changes until you save.

### Check what the change does, then save

As soon as your draft differs from what is saved, the editor checks who it affects and shows **What this change does** (*"Checking who is affected…"* while it works):

| Section | Meaning |
|---|---|
| **Lose actions they can do now** | People who can do something today and won't after you save. |
| **After saving, can't share new or revised agents (already shared ones stay)** | Agents already on the Hub stay shared; only new shares and new versions are stopped. |
| **Shared agents kept as they are** | What people already had, kept as it is: for example, everything that existed before group permissions were first turned on. |
| **Paused by this change** | Fleets, shared agents or chat access that the change pauses (see [Pause and resume](#4-turn-off-pause-and-resume)). |
| **Held, unchanged: N people** | See below. |

If no one loses anything, it says *"No one loses anything they can do now."* If the change would stop **you** from chatting with agents, it warns you first: *"After saving, you won't be able to chat with agents: no allowed row applies to you."*

**Held.** *"AD did not report group membership for these people. Nothing changes for them now: they gain nothing and nothing of theirs is paused. They are checked again at their next action."* Held people do not stop you from saving. The next time each of them does something on the Hub, the Hub asks the directory again and applies the policy then.

Then choose **Save**, or **Turn on and save** the first time. *"Saved."* confirms it. Saving applies exactly the change the check showed:

- If a group membership in the directory changed since the check, the Hub refuses the save, says *"Something changed since this was checked. Check again."*, and checks again for you. Look at the new result and save again.
- If you waited too long, it says *"This check expired. Check again."*
- If group permissions were saved from another tab or session, or fleets or shared agents changed on the Hub in the meantime: *"Someone else changed group permissions. Reload to see their version."*

## 2. What a colleague sees after signing in

After signing in, **Chats** opens the colleague's most recent room or chat. With nothing to open yet (and on **New chat**), it shows one list, *"Who do you want to talk to today?"*. That list has one row for each agent they can talk to: those shared with them, the Hub assistant, and the agents in their rooms. When nobody has shared an agent with them directly, one small card says what to do next, with **New room** and **Share my agent**. On a wide screen a line under the list shows their fleets, for example *"2 fleets connected (Han, My fleet)"*, and links to **My agents**.

Their fleets are listed in **My agents** → **My fleets**. Each fleet is a row with its state. When they may revoke it, **Revoke this fleet** is in the row's **⋯** menu and asks first. While they have no fleet, the steps to connect one are shown. Once they have one, the steps sit behind **+ Connect another fleet**: the address to paste in AgEnD's **Settings → Hub**, with **Copy**. What they see depends on what their groups allow:

| Their access | What they see |
|---|---|
| **Chat and Connect a fleet** | The list in **Chats**. **My fleets** shows *"N of M"*, their fleets and the steps to connect one. An older Hub or cached client keeps the administrator pairing-code guidance. |
| **Chat only** | The list in **Chats**. **My fleets** says *"Connecting a fleet is not included in your access."* |
| **Nothing allowed** | **Chats** says *"Your account can sign in, but no actions are allowed yet."* *"Contact your Hub administrator."* |
| **At their fleet limit** | **My fleets** says *"You have connected as many fleets as you may. Manage them, or ask your Hub administrator for more."* |
| **Directory not answering** | *"The directory didn't answer, so this can't be checked right now."* with **Retry**. The Hub never falls back to an old answer. |
| **Group permissions never turned on** | Chat works as before. **My fleets** isn't shown. |
| **Group permissions switched off** | **Chats** says *"Paused by your Hub administrator."*, and *"Your account can sign in, but no actions are allowed yet."* *"Contact your Hub administrator."* |

When chatting isn't available to them now, **Chats** says why in one line: *"Your Hub administrator has excluded your account from this."*, *"Your directory account can't use this right now."*, or *"Paused by your Hub administrator."* Each of their fleets shows its state: **Active**, **Paused**, **Revoked**, or **Can't be checked right now**.

An administrator gets the same **Chats**. On a Hub with no fleet connected yet, they also get one line that can be dismissed: *"Your Hub is ready: create a pairing code to invite colleagues, or set up the room assistant → Open Administration"*.

## 3. Quick pairing

When **Connect a fleet** is allowed and there is a free slot:

1. On the Hub welcome page, type a **Fleet name** you and your Hub admin will recognise and choose **Connect my fleet**. The Hub shows its **Hub address**, a **One-time code** and when the code expires (ten minutes).
2. In that fleet's web dashboard, open **Settings → Fleet → Hub**. If **Allow this fleet to connect to a Hub** (under **Hub membership**) is off, turn it on first. That change waits for its confirmation (*"Waiting for your confirmation…"*): confirm it where its card says, in General or on this dashboard.
3. Type the Hub address into the fleet's **Hub address** box and choose **Sign in with company account**; a Hub tab opens for company sign-in, then the fleet connects. (If the Hub doesn't offer company sign-in, use **Other ways** below the box instead: enter the member address shown with the code — it ends in a port — in **Hub address** and the 12-character code in **Pairing code**, then choose **Connect**.) Complete the local Settings confirmation if one is offered.
4. The fleet shows a **Waiting for approval** card with a pairing fingerprint, and the Hub shows its own. Compare them. On the fleet, choose **It matches the Hub's screen**; on the Hub, choose **They match**. If they differ, choose **They differ** and check the address before starting again. Neither screen's confirmation replaces the other.
5. The Hub shows **Connected** only after the fleet has saved its pin and connected. Pairing does not share any agent. Sharing still needs its own permission and confirmation. **Connect another fleet** starts another pairing while capacity remains.

You have at most one pending self-service offer. Starting again replaces its code and invalidates the old attempt. **Stop pairing** or expiry frees the pending slot. Retained fleets, including manually approved and paused fleets, count against later self-service pairing. If the directory cannot confirm access, pairing waits; it never uses an old permission to finish. Follow any uncertain-outcome warning on the fleet before trying again.

The Hub records a security notice for your other signed-in sessions, the Hub administrator and your other connected fleets. Offline delivery stays queued. Older fleet versions receive no new message until updated. Notices contain the fleet name and ID, not the code or credential. Expand **Earlier notices** and choose **Show older notices** to reach older retained records. A notice on your fleet offers **Review and revoke on the Hub**, where you sign in normally; that link grants no access. On the Hub, **Revoke this fleet** takes one click and affects only the named fleet.

The administrator can still explicitly approve ordinary manual pairing when a colleague has no self-service group allowance or their group membership cannot be checked. The directory account must remain enabled and eligible. A deliberate person exclusion for **Connect a fleet** still blocks it; the administrator must lift that exclusion first. Manual approval grants no Chat, Share or self-service permission. It may exceed the person's fleet limit, but retained manual fleets count against later self-service pairing and all Hub capacity limits.

## 4. Turn off, pause and resume

- **Turn the policy off:** **Turn off** in the editor, then save. Until you save, the editor shows *"Not saved"* and *"Turns off when you save; what depends on it is paused."* **Undo** cancels it. After saving: *"Switched off — resources paused"*.

  **Turning off pauses actions that depend on groups**, including chatting, sharing and self-service pairing, for the administrator too. Explicit manual pairing remains available; membership loss or switching off does not pause manual fleets. Person exclusions, directory ineligibility and revocation still apply. Fleets and shared agents that existed before group permissions were first turned on stay registered, but **nobody can ask any agent** until you turn group permissions on again **and** resume chat access in **Paused** (below). Once turned on, group permissions can be switched off but never return to the "never turned on" state.
- **Take a group away:** **Remove** the group, check **What this change does**, then save.
- **Resume something paused:** the editor's **Paused** section lists what was allowed by a group before and is paused now: fleets, shared agents and chat access (*"Allowed by a group before, paused now. Resume one after checking it is still wanted."*). Choose **Resume** on each one you still want (*"Resumed."*). Turning group permissions back on never resumes anything by itself: you decide, item by item.
- **Exclude a person:** **People excluded** is shown in the editor; adding someone to it from the editor is not available in this release.

**Revoke your own fleet:** use **Revoke this fleet** beside that fleet on your Hub welcome page or in its security notice. This remains available after you lose self-service permission, while your directory account remains eligible. It revokes the exact current fleet generation. Adding or revoking a person from the group editor remains a separate follow-up.

## See also

- [Connect a Fleet to a Hub](hub-join.md): the one-box connection and the administrator's **Let colleagues join** card.
- [Web dashboard](web-dashboard.md): signing in to your own fleet's dashboard.
- [Concepts](concepts.md): host owner, fleet admin and other roles.
