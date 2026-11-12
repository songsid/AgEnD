# Connect a Fleet to a Hub

[繁體中文](hub-join.zh-TW.md)

> AgEnD Hub is experimental and off by default. Nothing on this page applies until your company has set up a Hub.

A Hub lets colleagues ask each other's agents questions. Each person's AgEnD (their **Fleet**) connects to the company's Hub, and people sign in on the Hub with their **company account** (the Active Directory account they use at work).

This page has two parts:

- [For everyone: connect your Fleet](#for-everyone-connect-your-fleet)
- [For the Hub administrator: let colleagues join](#for-the-hub-administrator-let-colleagues-join)

## For everyone: connect your Fleet

You need the **Hub address** from your Hub administrator, for example `hub.example.com`.

1. On your AgEnD dashboard, open **Settings → Hub**.
2. In **Hub address**, type the address. `hub.example.com` is enough; you don't need `https://`. There is no switch to turn on first: connecting turns on this Fleet's Hub membership by itself.
3. Wait a moment. The page looks the Hub up and shows **Found "*Hub name*". This Fleet will appear as "*name*".** The name is this computer's name. To use another one, choose **Rename**.
4. Press **Sign in with company account**. A new tab opens on the Hub. Sign in there with your company account.
5. When it is done, the Hub tab says it is connected and closes by itself. Your Fleet's page updates on its own and shows the Hub's name and **Connected with *your name*'s company account · This Fleet is called "*name*"**.

A link your administrator gave you (`https://…/join-info#…`, such as the **Link with key fingerprint**) works in the same box.

### If it does not connect

The page says what happened and what to do. The most common messages:

| Message | What to do |
|---|---|
| That is not a Hub address. | Enter just the address, like `hub.example.com`. |
| A Hub address must use https. | Use the address without `http://`. |
| *host* cannot be reached. | Check the address, and that this computer is on the company network. |
| This computer does not trust *host*'s certificate. | Nothing was connected. Check the address or the certificate with your Hub administrator. |
| *host* is not an AgEnD Hub. | Check the address with your Hub administrator. |
| "*Hub*" does not accept company-account connections yet. | Ask the Hub administrator to turn them on. |
| The Hub and this Fleet need different host names. | The Hub and your AgEnD must have different host names; a different port is not enough. |
| "*Hub*" presents a different identity than before. | Nothing was connected. Check with your Hub administrator before you choose **Replace saved Hub identity**. |
| Your company account may not connect a Fleet. | Ask your Hub administrator to add you (or one of your groups). |
| You have reached the limit of connected Fleets. | Revoke one of your Fleets on the Hub first. |
| The Hub is handling other connections and will retry shortly. | Nothing to do; it tries again by itself. |
| This attempt timed out and nothing was created. | Press **Sign in with company account** again. |
| Another connection with a pairing code is still in progress for you. | Finish or stop it on the Hub first. |
| The result could not be confirmed. | Choose **Check this connection**. Do not start again. |

### Reconnect or remove the connection

- If the connection stops (the Hub revoked it, it expired, or it was refused), the card shows **Reconnect**. One press ends the old connection and opens the Hub's sign-in again. If the Hub's identity has changed, it stops and tells you, as above.
- **Remove this connection** ends it from your side. The agents you share stop answering on the Hub.

### Other ways

Under **Other ways** there is the older **pairing code** method, for a Hub that cannot use company sign-in. If you paste a pairing code into the Hub address box, the page opens **Other ways** for you with it filled in. Its switch, **Allow this fleet to connect to a Hub**, applies as soon as you change it (there is no Save).

## For the Hub administrator: let colleagues join

On the Hub, **Administration** opens with the **Let colleagues join** card. While no Fleet is connected yet, the same card is also on your welcome page. It has three steps. Steps 1 and 2 are marked **Done** from what the Hub has saved.

1. **Let colleagues connect Fleets with their company account.** Turn on **Allow company-account Fleet connections**.
2. **Who can join.** Search for the AD groups whose members may connect a Fleet (type the start of a group's name), and add them. For each group, set **Each person up to *N* Fleets**, and whether its members may also **Chat with agents** and **Share agents**. Before you press **Save**, the card shows what the change does (who loses something, and what is paused). A group the search doesn't find can be added under **Add by distinguished name**. If your directory can't list groups, the card says so; ask whoever set up the Hub. More about groups: [Hub group permissions](hub-group-permissions.md).
3. **Tell colleagues how to join.** Once steps 1 and 2 are done, the card shows one sentence with your Hub's address: "In AgEnD, open Settings → Hub, enter *hub.example.com*, then sign in with the company account." **Copy these instructions** and send it to your colleagues. They follow [the steps above](#for-everyone-connect-your-fleet).

Under the card:

- **Invitation exceptions** lets one named person connect without being in an allowed group.
- **Link with key fingerprint (Advanced)** is a link that also carries the Hub's identity, for a colleague who must check the fingerprint by hand. They paste it into the same Hub address box.

The **Connected fleets** list shows each Fleet by its name, with its owner under it. Revoked Fleets are folded under **Revoked (*n*)**. To end a Fleet's connection from the Hub, open its row's menu and choose **Revoke…**.

### Coming later: join codes

> Not in this release yet. A Fleet given a code for a Hub that does not offer join codes refuses it and sends nothing.

A join code will let a group of people connect at once, for example everyone at a workshop, without adding a group first.

- The administrator creates one in step 3 of the card. They choose how long it lasts (1 hour, until the end of today, or 7 days at most), how many Fleets it may connect (up to 200; 30 by default), and who may use it: anyone in the company directory, or the members of one group. Under **More** they set how many Fleets each person may connect with it (1 by default).
- The code is 8 characters, shown as `XXXX-XXXX`. Colleagues type the Hub address and the code in the same box: `hub.example.com K7QF-3M9P`.
- The card shows how many Fleets have joined with it and who they are. A code can be turned off at once. Fleets that already joined stay connected; revoke them one by one if needed.
- A code only stands in for the administrator's approval. Each person still presses **Sign in with company account** on their own Fleet and signs in on the Hub with their own company account. Without a company account a code is useless.
- Treat a live code like a key to a meeting room: anyone in the company who gets it can connect a Fleet under their own name until it ends or runs out. Make it short-lived, and turn it off when you are done.
