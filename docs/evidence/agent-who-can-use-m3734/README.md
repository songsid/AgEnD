# M-3734: an agent's page has Who can use (#4459, the user's 2X; real app)

**What it is.** Each agent's page, and each ClassicBot room's page, has a **Who can use** category (「誰能用」) just before Permissions. It lists and edits the two existing records of who can use the agent. It adds no permission model of its own.

- **Web guests** (`web.guests.grants`, the same data as Settings → Guests):
  - It lists everyone whose grant names this agent: their level, whether they're signed in, and which other agents they use.
  - **Add a person** offers the people AgEnD has seen in chat who aren't listed yet.
  - **Chat | Trusted** and **Remove** are the other actions. Remove asks first, and says so when it would end the person's guest access.
  - Each change writes one person's whole grant with Settings → Guests' own `PUT /api/settings/fleet/web`, built from the grant this page shows. The grant as shown goes with it as `if_grants` (Prism #4461 P2).
  - If that grant has changed since, the save is refused with 409 `guest_grant_changed`, either when it's admitted (before any confirmation is asked for) or when it applies. An edit made meanwhile in Settings → Guests is therefore never written over. Remove's question is about exactly what is written. The page then says nothing was saved and reads the list again.
  - The same Settings confirmation applies: adding someone, or making them Trusted, waits for a fleet admin; taking access away applies at once.
  - Before any grant is saved (#1920's derived access), the list is read-only and offers **Start from today's guests**. The page says what that does: everyone keeps exactly the agents they can use now, and from then on you add people per agent. It is sent only while no grants are saved (`if_grants: "unset"`). The server takes it only while it equals each guest's derived access at that moment, checked at admission and again as it applies (Prism #4461 R1), so access narrowed since the page read it is never put back. A single grant would take everyone else's access away.
  - Add a person says who is listed, what to do when someone is missing (they send one of your agents a message once) and who confirms (you, on the confirm card at the top of the page, or an admin in General).
  - A person's level (Chat or Trusted) covers all their agents, and their row says so when they have more than this one.
- **Hub:**
  - It shows whether the agent is shared, waiting, lapsed, refused or paused, or that no Hub is connected.
  - When the agent is shared, **Choose who may ask on the Hub** opens the Hub's own page (`?agent=<exposure>&grant=1`, as Settings → Hub does) in a new tab.
  - It names the button and says that the page opens only on the internal network, not from outside it (for example, at home).
  - The Fleet never reads or writes who may ask.

Fleet admins can always use every agent. A bot's Discord or Telegram `allowed_users` is unchanged.

**Captures.** From the real web app (`scripts/manual/smoke-fixture`), headless Chromium, at 6cb4ea444 (`src` clean). The script is `scripts/manual/agent-who-can-use-m3734/capture.mts`. The guests and people are made up and on Discord:
- Alice: Chat, alpha.
- Bob: beta only, so not listed.
- Carol: Trusted, alpha and beta.
- Dan: seen in chat.

The member's two Hub reads (pairing, exposures) are answered with fixture data, as in `scripts/manual/hub-share-lapse-m3543`. **76 of 76 checks pass.** `receipt.json` lists each check, the measurements and each PNG's sha256.

| Frame | Files |
|---|---|
| Phone: the agent page's category list (Who can use before Permissions) | `m3734-phone-{light-zh-TW,dark-en}-0-index.png` |
| The section: guests and the Hub share with its link | `m3734-<case>-1-who.png` |
| Add a person open | `m3734-<case>-2-add.png` |
| Remove's question (Cancel: nothing written) | `m3734-<case>-3-remove.png` |
| No grants saved yet, no Hub | `m3734-<case>-4-nohub.png` |
| The Hub card: shared, its button, where the page opens | `m3734-<case>-5-hub.png` |

The cases are desk light en, desk dark zh-TW, phone light zh-TW and phone dark en.

What the checks cover:
- the rows and levels, and Carol's "level applies to all 2 agents" note;
- the scope showing the agent's display name (desk);
- the Hub button by name, on screen, with its address and target, and the note that it doesn't open outside the internal network;
- every control in the section at least 44 px tall, on screen and with its label inside it (that last part failed on the earlier CSS: the Hub card's two buttons overflowed at 390 px, phone dark en);
- no sideways scroll;
- no console error and no failed read.

One read is left out of that last check: the Overview's board-work read (`/ui/tasks/work`) answers 503 on every agent page here, because the fixture runs no task board.

**Tests.**
- `tests/agent-who-can-use-m3734.test.ts`, the panel as rendered:
  - each write's exact body with its `if_grants`; a 409 saying nothing was saved, then a re-read; Remove's question matching what's written;
  - the 202 confirmation and a refused grant;
  - the derived-access mode, 403, and an agent that can't be granted;
  - every Hub state, the https-only link, and no read with no Hub;
  - every route on the fixed link's list;
  - the words key for key in en and zh-TW.
- `tests/guest-grants-2348.test.ts` (M-3734 block), through the real gate and handler:
  - a beta added elsewhere before Remove;
  - [a, b] → [a] before an ordinary Remove;
  - a widening refused at admission;
  - a change after admission (the confirmation's baseline goes stale);
  - the handler's own check;
  - Start from today's guests once grants exist, after a narrowing (at admission and on the replay), leaving someone out, adding someone, or with no readable scope;
  - and that an unchanged grant applies.
- Mutations each fail a test:
  - the gate check, the handler check, "unset", and the page sending no `if_grants`;
  - earlier: the Hub-mark checks, ending the last agent, derived vs explicit, Add in derived mode, and the pending state.
