# Connect a Fleet to a Hub

[繁體中文](hub-join.zh-TW.md)

> AgEnD Hub is a preview and off by default. Nothing on this page applies until your company has set up a Hub.

A Hub lets colleagues ask each other's agents questions. Each person's AgEnD (their **Fleet**) connects to the company's Hub, and people sign in on the Hub with their **company account** (the Active Directory account they use at work).

This page has two parts:

- [For everyone: connect your Fleet](#for-everyone-connect-your-fleet)
- [For the Hub administrator: let colleagues join](#for-the-hub-administrator-let-colleagues-join)

## For everyone: connect your Fleet

You need the **Hub address** from your Hub administrator, for example `hub.example.com`. Your administrator may also give you a **join code**, for example `K7QF-3M9P`.

1. On your AgEnD dashboard, open **Settings → Hub**.
2. In **Hub address**, type the address. `hub.example.com` is enough; you don't need `https://`. There is no switch to turn on first: connecting turns on this Fleet's Hub membership by itself.
   - **With a join code:** type the address, a space, then the code: `hub.example.com K7QF-3M9P`. You can also paste the whole message your administrator copied for you ("In AgEnD Settings → Hub, enter hub.example.com and this code.", with the code below it). The page picks out the address and the code, and says **Join code included.**
   - A code typed on its own gets: "That is a join code. Put the Hub address before it, with a space."
3. Wait a moment. The page looks the Hub up and shows **Found "*Hub name*". This Fleet will appear as "*name*".** The name is this computer's name. To use another one, choose **Rename**.
4. Press **Sign in with company account**. A new tab opens on the Hub. Sign in there with your company account. If the page first asks you to confirm that it is really you connecting this Fleet, choose **Go to the confirm card** and confirm there; the Hub sign-in opens after that.
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
| The Hub did not accept this join code… | It may have ended or been mistyped, or your account may not connect a Fleet. Ask your Hub administrator for a current code, then start again. |
| This join code is no longer valid or has been used up. | Ask your Hub administrator for a new code. |
| Another connection attempt is still open (shown above). | Use **Recover this connection** or **Cancel connection** on it, then start again. |
| You are outside the scope of this join code. | The code is for one group you're not in. Ask your Hub administrator. |
| Many people are connecting at once. Waiting in the queue… (or Waiting in the queue… Retry *n* of 8.) | Nothing to do; the Hub tab keeps trying by itself. |

### Reconnect or remove the connection

- If the connection stops (the Hub revoked it, it expired, or it was refused), the card shows **Reconnect**. One press ends the old connection and opens the Hub's sign-in again. If the Hub's identity has changed, it stops and tells you, as above.
- **Remove this connection** ends it from your side. The agents you share stop answering on the Hub.

### Other ways

Under **Other ways** there is the older **pairing code** method, for a Hub that cannot use company sign-in. If you paste a pairing code into the Hub address box, the page opens **Other ways** for you with it filled in. Its switch, **Allow this fleet to connect to a Hub**, applies as soon as you change it (there is no Save).

## For the Hub administrator: let colleagues join

On the Hub, **Administration** opens with the **Let colleagues join** card. While no Fleet is connected yet, the same card is also on your welcome page. It has three steps. Steps 1 and 2 are marked **Done** from what the Hub has saved.

1. **Let colleagues connect Fleets with their company account.** Turn on **Allow company-account Fleet connections**.
2. **Who can join.** Search for the AD groups whose members may connect a Fleet (type the start of a group's name), and add them. For each group, set **Each person up to *N* Fleets**, and whether its members may also **Chat with agents** and **Share agents**. Before you press **Save**, the card shows what the change does (who loses something, and what is paused). A group the search doesn't find can be added under **Add by distinguished name**. Group search needs Active Directory over LDAPS; if your directory can't list groups, the card says so. Check it with **Edit AD connection** on the Administration page, or use individual invitations or a join code instead. A live join code also completes this step. More about groups: [Hub group permissions](hub-group-permissions.md).
3. **Tell colleagues how to join.** Once steps 1 and 2 are done, the card shows one sentence with your Hub's address: "In AgEnD, open Settings → Hub, enter *hub.example.com*, then sign in with the company account." **Copy these instructions** and send it to your colleagues. They follow [the steps above](#for-everyone-connect-your-fleet). Step 3 is also where you create a [join code](#join-codes).

Under the card:

- **Individual invitations** lets one named person connect without being in an allowed group.
- **Link with key fingerprint (Advanced)** is a link that also carries the Hub's identity, for a colleague who must check the fingerprint by hand. They paste it into the same Hub address box.

The **Connected fleets** list shows each Fleet by its name, with its owner under it. Revoked Fleets are folded under **Revoked (*n*)**. To end a Fleet's connection from the Hub, open its row's menu and choose **Revoke…**.

### Join codes

A join code lets a group of people connect at once, for example everyone at a workshop, without adding a group first.

1. In step 3 of the card, press **Create join code** and choose:
   - **Valid until:** In 1 hour, End of today (the default), or In 7 days. A code can't be extended; create a new one.
   - **Maximum Fleets:** how many Fleets may connect with it, 1–200 (30 by default).
   - **Who can use it:** Anyone in the company directory, or One company group (**Find group**).
   - Under **More**, **Fleets per person** (1 by default, at most 8).
2. The card shows the code in large type (8 characters, `XXXX-XXXX`) and one sentence: "In AgEnD Settings → Hub, enter *hub.example.com* and this code." **Copy** it and send it to your colleagues. They type the address and the code in the same box: `hub.example.com K7QF-3M9P`, or paste the whole message.
3. While it is live, the card shows **Connected *n* / *max***, how many connections are in progress, and **Recent connections**. If the Hub has fewer free Fleet places than the code allows, the card says so.
4. **End this code now** asks first (**End this join code?**): the code can't be used again, and the dialog lists the Fleet connections still in progress with it, which stop. Fleets that already connected stay connected (revoke them one by one if needed).

A Hub keeps at most 8 live codes and creates at most 10 in an hour; past either limit the card says so.

- A code only stands in for your approval. Each person still presses **Sign in with company account** on their own Fleet and signs in on the Hub with their own company account. Without a company account a code is useless, and it never lets anyone ask or share agents.
- Treat a live code like a key to a meeting room: anyone in the company who gets it can connect a Fleet under their own name until it ends or runs out. Make it short-lived, and end it when you are done.
