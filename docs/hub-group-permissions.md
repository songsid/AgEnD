# Hub group permissions

中文版：[hub-group-permissions.zh-TW.md](hub-group-permissions.zh-TW.md)

> **Experimental. 2.3.5-alpha.8 and later only, and off by default.** Group permissions let a Hub administrator decide, by Active Directory security group, what signed-in colleagues may do on the AgEnD Hub. Until an administrator turns them on, the Hub behaves as before.

Everyone in your directory can still **sign in** to the Hub. Group permissions decide what each person can **do** after signing in:

| Permission | What it lets a member do |
|---|---|
| **Chat with agents** | Ask the agents their owners have shared with them. The agent's owner still has to give each person access; the group permission alone opens nothing. |
| **Share agents** | Share new agents, or new versions of agents, from their own fleet on the Hub. Each share still needs the owner's own confirmation. |
| **Connect a fleet** | Pair their own AgEnD fleet through self-service, up to the **Fleets** number set for the group (0–8). With **Fleets** at 0, self-service is unavailable even though the box is ticked; explicit administrator approval remains available as described below. |

A person who is in several groups gets everything any of their groups allows, and the highest **Fleets** number among their groups that allow **Connect a fleet**. A person listed under **People excluded** is denied what they are excluded from: exclusions win over any group.

## 1. Set up access for a department (Hub administrator)

### Where the editor is

Only the Hub's directory administrator can open it. Either:

- **On the Hub:** open the menu on your account in the sidebar (**Menu**), choose **Administration**, then, on the **Group permissions** card (tagged *Experimental*), choose **Open group permissions**.
- **From your fleet's dashboard** (the fleet that hosts the Hub): **Settings → Fleet → Hub**, then, on the **Group permissions** card, choose **Open on the Hub**. It opens the Hub's editor in a new tab.

Someone who is not the Hub administrator sees *"Only the Hub administrator can see this"* on the Administration page instead. If the Hub is too old to have the editor, the link says *"Group permissions aren't available on this Hub yet. Update the Hub, then try again."*

### Add a group

1. In **Group (distinguished name)**, type the group's distinguished name, for example `CN=Hub-Members,OU=Groups,DC=example,DC=test`.
2. Choose **Add group**. The Hub looks the group up in your directory (*"Looking up the group…"*).

The group must be a **security group** that exists in the directory. The editor says so plainly if it is not: *"No such group in the directory."*, *"That is not a security group."*, *"That is not a distinguished name."*, or *"That group is already listed."*

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

If no one loses anything, it says *"No one loses anything they can do now."* If the change would stop **you** from chatting with agents, it warns you first: *"After saving, you won't be able to chat with agents: you are not in a group that allows it."*

**Held.** *"AD did not report group membership for these people. Nothing changes for them now: they gain nothing and nothing of theirs is paused. They are checked again at their next action."* Held people do not stop you from saving. The next time each of them does something on the Hub, the Hub asks the directory again and applies the policy then.

Then choose **Save**, or **Turn on and save** the first time. *"Saved."* confirms it. Saving applies exactly the change the check showed:

- If a group membership in the directory changed since the check, the Hub refuses the save, says *"Something changed since this was checked. Check again."*, and checks again for you. Look at the new result and save again.
- If you waited too long, it says *"This check expired. Check again."*
- If group permissions were saved from another tab or session, or fleets or shared agents changed on the Hub in the meantime: *"Someone else changed group permissions. Reload to see their version."*

## 2. What a colleague sees after signing in

After signing in, a colleague's home page greets them (**Welcome, *name*** — *"What would you like to do?"*) with two cards, **Chat with an agent** and **Connect your fleet**. What the cards say depends on what their groups allow:

| Their access | What they see |
|---|---|
| **Chat and Connect a fleet** | Both cards on. **Chat with an agent** has **Open chats**; **Connect your fleet** shows *"Your fleets: N of M"*, a fleet-name field and **Connect my fleet**. An older Hub or cached client keeps the administrator pairing-code guidance. |
| **Chat only** | **Chat with an agent** is on; **Connect your fleet** is off, with the reason *"Connecting a fleet is not included in your access."* |
| **Nothing allowed** | Both off: *"Your account can sign in, but no actions are allowed yet."* *"Contact your Hub admin."* |
| **At their fleet limit** | *"You have connected as many fleets as you may. Manage them, or ask your Hub admin for more."* |
| **Directory not answering** | *"The directory didn't answer, so this can't be checked right now."* with **Retry**. The Hub never falls back to an old answer. |
| **Group permissions never turned on** | Chat works as before; **Connect your fleet** shows only the pairing-code note. |
| **Group permissions switched off** | Both cards off with *"Paused by your Hub admin."*, and *"Your account can sign in, but no actions are allowed yet."* *"Contact your Hub admin."* |

If no agent has been shared with them yet, the chat card says *"No agents have been shared with you yet. An agent's owner has to give you access."* A card that is off says why: *"Your Hub admin has excluded your account from this."*, *"Your directory account can't use this right now."*, or *"Paused by your Hub admin."*

Their own fleets are listed with their state: **Active**, **Paused**, **Revoked**, or **Can't be checked right now**.

## 3. Quick pairing

When **Connect a fleet** is allowed and there is a free slot:

1. On the Hub welcome page, enter a name you recognize for your fleet and choose **Connect my fleet**. The Hub shows its **Member address** and a one-time code, valid for ten minutes.
2. In that fleet's web dashboard, open **Settings → Fleet → Hub**, enable Hub membership if needed, and enter the member address and code. Complete the local Settings confirmation if one is offered.
3. Compare the fingerprint shown in both places. On the fleet, choose the button saying it matches the Hub screen; on the Hub, choose **They match**. If they differ, choose **They differ** and check the address before starting again. Neither screen's confirmation replaces the other.
4. The Hub shows **Connected** only after the fleet has saved its pin and connected. Pairing does not share any agent. Sharing still needs its own permission and confirmation. **Connect another fleet** starts another pairing while capacity remains.

You have at most one pending self-service offer. Starting again replaces its code and invalidates the old attempt. **Stop pairing** or expiry frees the pending slot. Retained fleets, including manually approved and paused fleets, count against later self-service pairing. If the directory cannot confirm access, pairing waits; it never uses an old permission to finish. Follow any uncertain-outcome warning on the fleet before trying again.

The Hub records a security notice for your other signed-in sessions, the Hub administrator and your other connected fleets. Offline delivery stays queued. Older fleet versions receive no new message until updated. Notices contain the fleet name and ID, not the code or credential. A notice on your fleet offers **Review and revoke on the Hub**, where you sign in normally; that link grants no access. On the Hub, **Revoke this fleet** takes one click and affects only the named fleet.

The administrator can still explicitly approve ordinary manual pairing when a colleague has no self-service group allowance or their group membership cannot be checked. The directory account must remain enabled and eligible. A deliberate person exclusion for **Connect a fleet** still blocks it; the administrator must lift that exclusion first. Manual approval grants no Chat, Share or self-service permission. It may exceed the person's fleet limit, but retained manual fleets count against later self-service pairing and all Hub capacity limits.

The administrator can still explicitly approve ordinary manual pairing when a colleague has no self-service group allowance or their group membership cannot be checked. The directory account must remain enabled and eligible. A deliberate person exclusion for **Connect a fleet** still blocks it; the administrator must lift that exclusion first. Manual approval grants no Chat, Share or self-service permission. It may exceed the person's fleet limit, but retained manual fleets count against later self-service pairing and all Hub capacity limits.

## 4. Turn off, pause and resume

- **Turn the policy off:** **Turn off** in the editor, then save. Until you save, the editor shows *"Not saved"* and *"Turns off when you save; what depends on it is paused."* **Undo** cancels it. After saving: *"Switched off — resources paused"*.

  **Turning off pauses actions that depend on groups**, including chatting, sharing and self-service pairing, for the administrator too. Explicit manual pairing remains available; membership loss or switching off does not pause manual fleets. Person exclusions, directory ineligibility and revocation still apply. Fleets and shared agents that existed before group permissions were first turned on stay registered, but **nobody can ask any agent** until you turn group permissions on again **and** resume chat access in **Paused** (below). Once turned on, group permissions can be switched off but never return to the "never turned on" state.
- **Take a group away:** **Remove** the group, check **What this change does**, then save.
- **Resume something paused:** the editor's **Paused** section lists what was allowed by a group before and is paused now: fleets, shared agents and chat access (*"Allowed by a group before, paused now. Resume one after checking it is still wanted."*). Choose **Resume** on each one you still want (*"Resumed."*). Turning group permissions back on never resumes anything by itself: you decide, item by item.
- **Exclude a person:** **People excluded** is shown in the editor; adding someone to it from the editor is not available in this release.

**Revoke your own fleet:** use **Revoke this fleet** beside that fleet on your Hub welcome page or in its security notice. This remains available after you lose self-service permission, while your directory account remains eligible. It revokes the exact current fleet generation. Adding or revoking a person from the group editor remains a separate follow-up.

## See also

- [Web dashboard](web-dashboard.md): signing in to your own fleet's dashboard.
- [Concepts](concepts.md): host owner, fleet admin and other roles.
