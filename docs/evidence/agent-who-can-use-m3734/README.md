# M-3734: an agent's page has Who can use (#4459, the user's 2X; real app)

**What it is.** Each agent's page, and each ClassicBot room's page, has a **Who can use** category (「誰能用」) just before Permissions. It lists and edits the two existing records of who can use the agent. It adds no permission model of its own.

- **Web guests** (`web.guests.grants`, the same data as Settings → Guests):
  - It lists everyone whose grant names this agent: their level, whether they're signed in, and which other agents they use.
  - **Add a person** offers the people AgEnD has seen in chat who aren't listed yet.
  - **Chat | Trusted** and **Remove** are the other actions. Remove asks first, and says so when it would end the person's guest access.
  - Each change writes one person's whole grant with Settings → Guests' own `PUT /api/settings/fleet/web`. It starts from the grant as saved at that moment, so an edit made meanwhile in Settings → Guests is kept.
  - The same Settings confirmation applies: adding someone, or making them Trusted, waits for a fleet admin; taking access away applies at once.
  - Before any grant is saved (#1920's derived access), the list is read-only and offers **Start from today's guests**. A single grant would take everyone else's access away.
- **Hub:**
  - It shows whether the agent is shared, waiting, lapsed, refused or paused, or that no Hub is connected.
  - When the agent is shared, **Choose who may ask on the Hub** opens the Hub's own page (`?agent=<exposure>&grant=1`, as Settings → Hub does) in a new tab.
  - It says that this page only opens where the Hub can be reached, which today is the company network.
  - The Fleet never reads or writes who may ask.

Fleet admins can always use every agent. A bot's Discord or Telegram `allowed_users` is unchanged.

**Captures.** From the real web app (`scripts/manual/smoke-fixture`), headless Chromium, at 776ff1e02 (`src` clean). The script is `scripts/manual/agent-who-can-use-m3734/capture.mts`. The guests and people are made up and on Discord:
- Alice: Chat, alpha.
- Bob: beta only, so not listed.
- Carol: Trusted, alpha and beta.
- Dan: seen in chat.

The member's two Hub reads (pairing, exposures) are answered with fixture data, as in `scripts/manual/hub-share-lapse-m3543`. **66 of 66 checks pass.** `receipt.json` lists each check, the measurements and each PNG's sha256.

| Frame | Files |
|---|---|
| Phone: the agent page's category list (Who can use before Permissions) | `m3734-phone-{light-zh-TW,dark-en}-0-index.png` |
| The section: guests and the Hub share with its link | `m3734-<case>-1-who.png` |
| Add a person open | `m3734-<case>-2-add.png` |
| Remove's question (Cancel: nothing written) | `m3734-<case>-3-remove.png` |
| No grants saved yet, no Hub | `m3734-<case>-4-nohub.png` |

The cases are desk light en, desk dark zh-TW, phone light zh-TW and phone dark en.

What the checks cover:
- the rows and levels;
- the Hub link's address, target and its "only where the Hub can be reached" note;
- every control in the section at least 44 px tall and on screen;
- no sideways scroll;
- no console error and no failed read.

One read is left out of that last check: the Overview's board-work read (`/ui/tasks/work`) answers 503 on every agent page here, because the fixture runs no task board.

**Tests.**
- `tests/agent-who-can-use-m3734.test.ts`, the panel as rendered:
  - each write's exact body, including a grant changed elsewhere being kept;
  - the 202 confirmation and a refused grant;
  - the derived-access mode, 403, and an agent that can't be granted;
  - every Hub state, the https-only link, and no read with no Hub;
  - every route on the fixed link's list;
  - the words key for key in en and zh-TW.
- Mutations: the stale-grant write, the Hub-mark checks, ending the last agent, derived vs explicit, Add in derived mode and the pending state each fail a test.
