# The Office view

[繁體中文](office.zh-TW.md)

**Fleet → Org chart → Office** draws your fleet as a small pixel office. Each instance is a little person whose pose is its state, and the messages, delegations and reports between instances travel across the room. This guide covers using it, setting up offices, making skin packs, arranging a layout and letting agents take part.

> **Versions.** The Office view came in **2.3.0**, with the Desks and Studio styles and stored offices. Almost everything else here arrived in the **2.3.2 betas**, and two furniture keys are not released yet; [Versions](#versions) lists each feature. A feature marked **Not released yet** is on `main` but in no published version, so don't rely on it until it ships.

- [A quick tour](#a-quick-tour)
- [Set up an office](#set-up-an-office)
- [Use a skin pack](#use-a-skin-pack)
- [Make a skin pack](#make-a-skin-pack)
- [Arrange the layout](#arrange-the-layout)
- [Reserve seats](#reserve-seats)
- [Bedtime, strolls and mail](#bedtime-strolls-and-mail)
- [Share a view](#share-a-view)
- [Agents in the office](#agents-in-the-office)
- [Let an agent manage skin packs](#let-an-agent-manage-skin-packs)
- [Who can do what](#who-can-do-what)
- [Reference](#reference): [manifest](#the-manifest), [strips](#strips), [furniture](#furniture), [layout overrides](#layout-overrides), [limits](#limits), [files and settings](#files-and-settings)
- [Upgrading and rolling back](#upgrading-and-rolling-back)
- [Versions](#versions)

## A quick tour

Open the dashboard (`/web` in General), then **Fleet → Org chart** and pick **Office** beside Canvas and List. The choice is remembered on that device. Guests don't see the org chart or the Office.

**What a person's pose means.**

| State | Pose | Caption |
|---|---|---|
| working | typing at the desk | Typing away |
| idle | a tea break (in a zones style: the lounge) | Tea break |
| paused, stopped | asleep | Asleep |
| needs you, crashed, looks stuck | a raised hand | Calling for you |

Now and then a person says a short line for their state in a speech bubble. A bubble never shows message content.

**Moving around.** Drag to pan. The wheel or a pinch zooms. **+** / **−** step the zoom in whole pixel levels, and **Fit** shows the whole scene. **Fill** (kept per office) fills the panel instead and crops what overflows, so drag to see the rest. The keys `+`, `-` and `0` (fit) work while the office has focus, and `f` toggles **Fullscreen** (Esc leaves). The overview at the bottom right jumps to a spot. It hides while a single office is all in view (it would repeat the panel) and comes back once you zoom in, pan or Fill; All offices always shows it. It's not shown on a phone. The zoom, centre and Fit/Fill are kept per device for each office and style. Drawing is always unsmoothed pixel art. Zooming and panning never animate.

**Fullscreen** shows the office alone, with the zoom buttons, the overview, a compact office switcher and Exit floating over it. Where a page can't go fullscreen (an iPhone) or the browser refuses, the office covers the window instead. Opening a chat leaves fullscreen, and nothing about it is remembered.

**On a phone** the scene takes the height left under the bars, so a zoomed-in scene can be dragged to its bottom edge. Outside fullscreen the zoom buttons are a row along the top. Only a very short screen keeps a 200 px stage and scrolls the panel; swipe on the bars to scroll it.

**Hover and click.** Hover over a person for their name, state and backend. Click (or tap) them, or press Enter on their entry in the desk list, to open their [profile card](#the-profile-card). Double-click a person to open their chat directly. **Find** dims everyone who doesn't match.

**The Office bar.**

| Control | What it does | Kept |
|---|---|---|
| **Office** | which office to show: **Whole fleet**, one of the stored offices, or **All offices** | per device |
| **Show** | a team or the Lobby only | per browser |
| **People** | pin chosen instances; **Show everyone** clears it | per browser |
| **Style** | **Desks**, **Studio**, **Cozy** or an uploaded skin pack (for Whole fleet; a stored office has its own) | for the whole fleet when a fleet admin picks it; anyone else's pick is their own browser's |
| **Hide paused and stopped** | leaves the sleepers out | per browser |
| **Bedtime 0–6: the idle sleep** | see [Bedtime](#bedtime-strolls-and-mail) (zones styles and All offices) | per device, off by default |
| **Lobby tile** | in All offices, a tile for the instances in no office | per browser, on by default |

**The styles.**

- **Desks** draws a room per team with a desk per instance; General and the instances in no team share the lobby. A delegation in progress is a folder on the worker's desk. A Desks office smaller than the panel is centred in it.
- **Studio** is one scene with four areas (Work, Lounge, Help desk and Nap corner). Each instance walks to the area for its state, along corridors.
- **Cozy** is the same kind of scene in a warm pixel-art room drawn as one picture that ships with AgEnD: desks, a sofa and coffee, beanbags and a whiteboard. Its notice board says a skin pack can restyle the room. Cozy is the default for a browser that hasn't picked a style and for a new office. A saved office keeps its own style.
- An **uploaded skin pack** is either kind of scene: a zones scene like Studio, or a Desks-like layout with its own pictures.

Studio, Cozy and zones packs are called **zones styles** below. Only they have walking, seats, Edit layout, bedtime, strolls and mail.

**Crowds.** An area with more people than seats packs the rest into a tighter grid, then shows "+N" in its corner. There only calls and work get bubbles (a few at most), and name tags show on hover or focus.

**All offices** (in the switcher once two or more offices are stored) shows every stored office as a tile, each drawn exactly as its own view and labelled with its name and head count. The **Lobby tile** adds the instances in no office. It's disabled, with a note, when everyone is in an office. A tile's label, or a double-click on the tile, opens that office. Traffic between people in different offices flies straight between their seats. Below 75% zoom a tile's name tags show on hover only. Edit offices and Edit layout wait until a single office is shown.

**Reduced motion** (the system setting) shows still poses, nothing in the air, and bubbles whole at once.

## Set up an office

A fleet admin, on the dashboard reached directly (not over the public link), uses **Edit offices** in the Office bar. On a screen 1200 px or wider it opens as a panel on the right, in place of the AI usage rail, with the Office still usable beside it. Narrower, it's a centred dialog. × or Esc closes it.

1. **Add office**, and give it a name.
2. **Who is in it**: **Everyone**; **Picked**, then whole teams or single instances (with none ticked yet it still shows everyone); or **Nobody (NPCs only)**: no agent sits there, only its style's NPCs (not released yet, #2752). In `web-offices.json` everyone is `"members": []` and nobody is `"members": ["team:"]`, a team with no name, which no team has.
3. **Style**: Desks, Studio, Cozy or a kept skin pack.
4. **Save.**

Offices are the fleet's: everyone sees the same ones. The host keeps them in `web-offices.json` in the AgEnD home (`GET` / `PUT /ui/offices`), never in fleet.yaml, so a change restarts nothing. There can be at most 20 offices, and one person can save at most 20 times a minute.

If someone saved the offices while you were editing, your save is refused and nothing is overwritten. Choose **Keep my edits** (the next Save replaces their change) or **Load theirs**. Leaving the page with unsaved changes asks first.

**Whole fleet** is the page's own office, built from your teams each time. It is never stored as an office, but its style is kept on the host: a fleet admin's pick in the Office bar is what every device and every share link shows. Someone who can't edit offices may pick a style too; it stays in their browser and is used there instead. An admin's own pick from before the host kept one is sent up the first time they open the Office.

## Use a skin pack

A skin pack is an artist's pictures for the Office: a `manifest.json` and PNG files. Making one is described in [Make a skin pack](#make-a-skin-pack).

**Upload one.** In **Edit offices → Skin packs**, use **Upload a skin pack** and pick the pack's `manifest.json` and all its PNG files together, or use **Upload a folder**. The host checks everything (see [Limits](#limits)). On the first problem it refuses the upload and says where the problem is, for example `furniture[3].sprite.w: a whole number from 1 to 512`. Packs are kept whole in `web-office-skins/<id>/` in the AgEnD home and never changed.

**Use it.** Kept packs appear in every **Style** picker. Pick one for an office in Edit offices, or for Whole fleet in the Office bar. A pack the page can't load is drawn as Desks, with a note.

**Change it.** From the web, delete the pack and upload the new version; an id the host already keeps is refused. An agent with [pack access](#let-an-agent-manage-skin-packs) can instead replace a pack in place and keep its previous version for a restore.

**Delete it.** Use the pack's delete button. Offices drawn in it fall back to Desks, with a note.

## Make a skin pack

A pack describes one scene on a **1280×720 logical canvas** (16:9). Every coordinate in the manifest is in these logical units. Pictures are pixel art, drawn unsmoothed at `scale` logical units per image pixel (default 2).

A minimal zones pack:

```json
{
  "format": 1,
  "id": "harbour",
  "background": "room.png",
  "areas": {
    "desks":  { "rect": [40, 120, 620, 440], "seats": [[120, 220], [260, 220], [400, 220]] },
    "lounge": { "rect": [700, 120, 540, 260], "seats": [[760, 260], [880, 260]] },
    "nap":    { "rect": [700, 420, 540, 260], "seats": [[780, 560]] }
  },
  "stateZones": { "working": "desks", "paused": "nap", "stopped": "nap", "default": "lounge" },
  "characters": {
    "default": {
      "idle":    { "src": "people/idle.png", "frames": 4, "w": 32, "h": 48, "fps": 4 },
      "working": { "src": "people/work.png", "frames": 4, "w": 32, "h": 48, "fps": 6 },
      "walk":    { "src": "people/walk.png", "frames": 2, "w": 32, "h": 48, "fps": 6 }
    }
  }
}
```

`room.png` must be 16:9, and each strip's picture exactly `frames·w × h` pixels: 128×48 for `idle` above.

**Areas, seats and states.** An area is a rect `[x, y, w, h]` and its seats in the order they fill up. A seat is `[x, y]`, where the person's feet go, inside its area's rect. `stateZones` sends each state (`needs`, `crashed`, `stuck`, `working`, `idle`, `paused`, `stopped`, `missing`) to an area; a state it doesn't name goes to `"default"`, else the first area. Bedtime sends the idle to the area `paused` uses.

**Characters.** `characters.default` with at least `idle` is required. A set's poses are `working`, `idle`, `paused` and `needs`; a missing pose is drawn as `idle`. More sets (up to 64) can be given to instances by name with `byInstance: { "atlas": "fox" }`.

**Walking.** People walk along the pack's graph (`waypoints` and `edges`) when it has one, else straight to their seat. Someone new walks in from the `door` (default: the bottom middle). The walking strips are picked by the direction of each step: `walkDown` (towards the viewer), `walkUp`, or `walkSide`, which is drawn facing right and mirrored for left. A missing one is `walk`, then idle. With `"straight": true` every diagonal leg of a walk becomes an L, across first and then up or down, so the three strips always match the way a person moves. Lay the graph out with horizontal and vertical edges and the corners land on the aisles.

**What flies.** Messages, delegations, reports and broadcasts fly between people as the pack's `props` (`task`, `send`, `report`, `broadcast`), else built-in items. A character set may have its own `prop`: everything its people send flies as that.

**Furniture.** Each item is a strip at `(x, y)` with a `depth`. Below 1000 it's drawn under the people, 1000 and up over them, and `"depth": "y"` sorts it among the people by its base, so whoever stands lower is in front. An item can:

- play when someone is in a state: `activeWhen` (a state or a list), optionally with its own `activeSprite`, and `activeFor` (an instance or a list of up to 8) to watch only those people. Otherwise it holds its first frame, or plays all along with `"loop": true`;
- wear a name tag with `label` (1–40 characters), like a person (an NPC drawn as furniture);
- stroll near its spot like an idle person with `walk` (its own walking strips, `walk` required);
- sleep at bedtime with `night`: `{ "sprite": STRIP, "x": …, "y": … }` (its own place when x/y are left out);
- **Not released yet:** wait for its person to sit down, and hide them. `"activeOn": "seated"` turns the item active only once one of its `activeFor` people, in that state, has reached their seat, and back as soon as they walk off (the default, `"state"`, follows the state). `"hides": true` (with `activeFor`) stops drawing those people while the item is active; someone walking is always drawn. Their name tags (one row at the item's tag point, after its own label) and bubbles go on the item, and hovering or clicking a person's tag or the item's picture selects that person. Use these for a bed, a sedan chair or a tent that becomes one picture with its person.

**Depth and framing.** A `foreground` is a 16:9 PNG over the whole scene, drawn above the people and furniture but below name tags, bubbles and "+N": use it for door frames, pillars and table fronts that hide whoever walks behind them. `matte` (`#rrggbb`) is the colour around the scene where the panel isn't 16:9; without it the page samples the background's edge.

**Bubbles.** `bubbles: { "en": { "working": ["On it."] }, "zh-TW": { … } }` replaces the page's own lines for a state: up to 12 lines, each 1–40 characters.

**A Desks-like pack.** A pack without `stateZones` keeps the Desks layout and may give its own `room` (`floor`, `wall`) and `desk` (`back`, `front`, `lit`) pictures.

**Sizes and anchors.** A strip's displayed size is `w·scale × h·scale`, unless it gives `dw` and/or `dh` in logical units; with only one of them, the other keeps the aspect. `(ax, ay)` is the image point placed on the position (default: bottom centre, so a person stands on their seat). Suggested sizes at scale 2: a character 32×48, a prop 12×12.

**Checking a pack.** The check is strict: an unknown key, a value out of range, or a name that refers to nothing refuses the whole pack, with where it broke. An agent with pack access can run `office_pack_check` on a folder without storing anything (see [below](#let-an-agent-manage-skin-packs)). The page and the host use the same rules.

## Arrange the layout

On a stored office in a zones style, a fleet admin can move things with **Edit layout**. Changes are kept as that office's own *overrides*; the pack stays as it was uploaded, and other offices on the same pack aren't affected.

- The overlay shows the 1280×720 coordinate grid (**Show coordinates**) and a handle for every seat, furniture item, the door, the mail drop and each waypoint. The mail drop is an envelope where letters from other offices land; on a pack that doesn't name one it's dashed and shows where letters land now, and dragging it gives the office its own. Each empty seat shows a faint figure posed for its area.
- Drag a handle, or Tab to one and use the arrow keys (Shift moves by 10).
- **Add waypoint** / **Remove waypoint**; with a waypoint selected, **Join to** another one or **Unjoin** a corridor.
- An item that sleeps at bedtime also has a night handle, "Item {id} (night)": its night picture drawn faint, a moon, and a thin line to its day place. Drag it to give the item its own night place; **Back to the pack's night place** undoes that.
- A selected seat has **Reserved for** and **Lend when away**; see [Reserve seats](#reserve-seats).
- **Save layout** keeps it; **Reset to the pack's layout** goes back to the pack's own; **Cancel** (or Esc) closes it.

On a screen 1200 px or wider its controls sit in the right-hand panel, leaving the whole canvas for the handles. Narrower, or in fullscreen, they are a bar along the canvas. While it's open, the office picker and Edit offices wait. If someone saved the offices meanwhile, Save says so and keeps your layout, and Save again puts it on the current list.

The host checks overrides on every save. Seats must stay inside their area, and each area keeps the pack's seat count. Overrides are made on one pack: on another style they're ignored ("Its saved layout does not fit this style"). If the pack is later replaced and the layout no longer fits, the office keeps the pack's own layout until someone fixes it; an agent replacing the pack is asked first (see `drop_invalid_overrides` [below](#let-an-agent-manage-skin-packs)).

## Reserve seats

Some poses are drawn for one seat, such as two people leaning towards each other on a sofa, or someone at their own desk. A reserved seat makes them come out right.

- In Edit layout, select a seat, then pick the office members it's **Reserved for** (several allowed). Its handle is ringed.
- Whoever a seat is for takes it first when they come to its area: the one they sat on last, else their first in the area's order.
- Nobody else sits there, unless **Lend when away** is on and all its people are elsewhere. A borrower moves off when one of them comes. Plain seats are given out before lent ones.
- A reserved seat that isn't lent, whose people are all elsewhere, doesn't count towards the area's room for a crowd.
- A pack can reserve seats too: a seat may be `{ "x": 760, "y": 260, "for": ["atlas"], "lend": false }` instead of `[x, y]`. An office's own reservations replace the pack's for that seat; reserving it for nobody undoes the pack's.

## Bedtime, strolls and mail

These need a zones style.

- **Bedtime** (the **Bedtime 0–6: the idle sleep** box, per device, off by default): from 00:00 to 06:00 on the viewer's clock, idle people go to the sleeping area (the area `paused` uses) while it has a free seat, and sleep there with Zzz bubbles. The rest doze where they are. Working people keep working. Furniture with a `night` is drawn asleep at its night place.
- **Strolls:** now and then an idle person walks to a nearby waypoint that no seat is on, stays a few seconds and walks back. A furniture item with `walk` strolls the same way. Strolls happen in a single office (not All offices), not with reduced motion, and not while Edit layout is open.
- **Mail:** a message to someone in this office from someone outside it flies in at the door as a letter and lands at the pack's `mailDrop` (or the office's own from Edit layout). Without one it lands at the waypoint nearest the middle of the room, off every seat. More letters wait 16 px apart to the right, never on a seat. With reduced motion no letters are shown. Its person walks over and picks it up, unless they're asleep. A letter waits up to a minute.
- **Traffic** between people in the same office flies from sender to receiver. A delegation stays in progress until the worker's report comes back.

## Share a view

A fleet admin can show the live Office to people outside the fleet for a while, with no sign-in. Use **Share…** in the Office bar, on the dashboard reached directly or signed in over the temporary public link; a read-only session or a guest can't share. There is no chat command for it.

1. Choose **Whole fleet**, one office or **All offices**, and how long: 15 minutes to 24 hours (1 hour by default; `web.office_share.max_hours` sets the longest). Whole fleet is the default while it's the office shown.
2. Choose the **Look**: **Light** or **Dark**, or **The viewer's device**. The default is the light or dark your dashboard shows now, the device's when it follows the device.
3. Tick **Include agents' own status lines** to show agents' `office_set` lines too.
4. **Create link**, then **Copy link**. Only you see the link, once.

A viewer sees that office (or every office) as the dashboard draws it, in its look, and Whole fleet in the fleet's style: the scene, names, identity colours and states, updated every 5 seconds, with zoom, Fit and fullscreen. Nothing else is shown: no chat, no settings, no models, costs or descriptions. Clicking a person opens their card with only their name, title, state, office and level. Only the office's members are shown, and an instance with `cross_instance_visibility: hidden` never is.

Each link has its own address on a quick tunnel (`https://<random>.trycloudflare.com/o/<token>`), separate from the dashboard's, which starts with the first link and stops with the last. At most 10 links are open at once. Each link is limited to 120 requests a minute, and skin-pack pictures are counted apart, so even All offices with full packs loads every room. A link ends at its time, on **Revoke** (in **Settings → Access & security → Office share links**, or under the Share… form), when `web.office_share.enabled` is set to `false`, when its maker is no longer a fleet admin, when its office is deleted, or on a fleet restart. Each link made or revoked is announced in General (never the link itself). When Cloudflare refuses a new quick tunnel, making a link says to try again in a few minutes.

More on the dashboard's ways in: [web-dashboard.md](web-dashboard.md#office-share-links).

## Agents in the office

An agent can see the offices it's in and direct its own character for a moment, once a person turns on its **Office** dashboard feature (`office_access: true`). The feature is off unless set, in **Settings → Agent defaults** or an agent's **Advanced → Dashboard access**; turning it on is confirmed, and turning it off removes the tools at once.

- `office_view { office? }`: the stored offices it's in, with their members and states. For an office in an uploaded zones pack it also lists the seats (`"area:index"`), waypoints, furniture (NPCs) and the door, with the office's layout overrides applied. Any other office (Desks, Studio, Cozy, or a pack without zones) returns `walks: false` and no spots.
- `office_set { office?, go?, say?, pose?, seconds?, clear? }`: walk to a seat, a waypoint or another member (`go`); say a line of 1–40 characters (`say`); hold a pose: idle, working, needs or paused (`pose`); for 5–120 seconds (default 30). `clear: true` ends it. Where `walks` is false, the line and the pose show, and `go` is refused.
- Each act replaces the last. It ends when its time is up or the agent starts new work, and it isn't shown while the agent calls for a person, is paused or stopped, or is asleep at bedtime. Acts are kept in memory only.
- At most 6 calls a minute and 60 an hour per agent; a refusal says `cooldown_ms`.
- Also on the command line: `agend-agent office view [office]` and `agend-agent office set '<json>'`.

## Let an agent manage skin packs

An agent can check, upload, replace, delete and restore skin packs itself, for example to publish an artist's fixes without a person uploading each one. Everyone on the fleet sees the packs, so this is a separate switch: **Office skin packs** (`office_pack_access: true`) in **Settings → Agent defaults** or an agent's **Advanced → Dashboard access**. It's off unless set, and turning it on is confirmed.

**The tools.**

| Tool | What it does |
|---|---|
| `office_pack_list` | each pack (id, name, files, bytes, version, a previous version to restore, the offices drawn in it), the stored offices, the approval mode, the agent's pending changes and what's left of its hour |
| `office_pack_check` | the host's own checks, storing nothing: `PACK OK` or the first refusal |
| `office_pack_upload` | the web upload's checks and limits; an id the fleet keeps is **replaced** at once |
| `office_pack_restore` | brings back the kept previous version (the replaced one becomes the previous, so a restore can be undone the same way) |
| `office_pack_delete` | deletes a pack, and its previous version too unless `keep_previous: true` |
| `office_set_style` | points a stored office at a kept pack or a built-in style (`pixel` = Desks, `studio`, `cozy`) |

**Sending a pack.** A pack is a folder (`dir`) holding its `manifest.json` and the PNGs at the paths the manifest names, or a `manifest` object plus `files` (`{ "<name it uses>": "<path>" }`). `packs: [...]` sends several as one batch. The agent's side reads only those files, in its working directory or the fleet's shared folder (`~/.agend/shared`). Symlinks are followed but must stay inside. The fleet receives the bytes, never a path.

**Replacing safely.** A replaced pack is checked and written first, then swapped in at once. On any failure the old one stays, and offices never fall back to Desks in between. One previous version is kept per pack, and doesn't count towards the 16 packs.

**When layouts no longer fit.** Every stored office with layout overrides on the pack is checked against the new version: seats, furniture, night places and seat reservations. If an entry no longer fits (a seat count changed, a seat left its area, an item or a reserved seat is gone), check, upload and restore refuse, naming the office and the rule. With `drop_invalid_overrides: true` they drop exactly those entries, one seat's reservation at a time and never an office's whole layout, and name them.

**Approval.** Fleet admins choose the mode in **Edit offices → Agents changing packs**:

- **Need my yes** (the default): each change waits as a pending change until a fleet admin approves it there, or with **Approve** / **Reject** on its notice in General. A change is judged again when approved. A change that drops layout entries is applied only if it still drops exactly the entries its notice named. If the offices were edited since then, approving it is refused and the agent has to send it again. Pending changes are kept in memory for 24 hours, at most 8 at once, and a fleet restart drops them.
- **Apply at once**: the change applies and the admins are told.

The same panel lists which agents may change packs, the changes waiting for your yes, and the recent changes.

**Records and limits.** Every upload, replace, delete and restore is logged in `~/.agend/web-office-skins/.agent-changes.log` (who, when, which pack, file count, bytes, and the sha256 of the manifest and each picture, so a restore can be matched to a version). The fleet's admins are told in General in one short message. Each agent may send at most 20 batches and 200 MiB an hour. One call is one batch of up to 16 packs and 100 MiB of pictures; refusals and checks don't count. Checks have their own allowance: 60 batches and 1 GiB as sent an hour per agent. Every check counts, whether it passes or not. On disk the packs may take 640 MiB in all: 16 full packs and a previous version of each.

Also on the command line: `agend-agent office packs`, `pack-check <dir>`, `pack-upload <dir>… [--drop-invalid-overrides]`, `pack-delete <id> [--keep-previous]`, `pack-restore <id>`, `style <office> <pack>`.

## Levels

Each instance has a level, from the work it has done over its whole recorded life (#2661).

- **Work tokens** are uncached input, cache writes and output. Cache reads don't count: they're most of nearly every instance's total, and counting them would put everyone at the same level.
- **Level** = floor(√(work tokens ÷ 100,000)), with no cap. 1M work tokens is about Lv 3, 260M about Lv 50, and 1B is Lv 100.
- The numbers come from the usage store the usage report reads ([Fleet → Usage](web-dashboard.md)); nothing new is collected and no transcript is read for it. Kiro's usage is estimated from text size, so a level that includes Kiro work is marked as estimated.
- **First seen** is the earliest day with recorded work. On a fleet older than its usage collection, that's the day collection began.
- The usage history keeps 400 days. Days older than that are added to `usage-lifetime.json` before they're pruned, so a level never drops.
- The fleet works the levels out at most once a minute, however many pages and share links ask.

Who sees what:

- **The dashboard:** every level, with the work tokens, today's work and requests, and first seen. The numbers follow the usage report's rules: none while `web.usage_panel` is `false`, and over the public link only with `web.usage_report_on_public_link: true`. Otherwise only the level is shown.
- **Share-link viewers:** the level of the people the share shows, and nothing else.
- **Guests:** no Office, so no levels.
- **Agents:** `office_view` lists each member's `level`. It changes nothing an agent can do.

`web.office_levels: false` turns levels off: the fleet serves none, and no badge or level row is shown. The switch is also in **Settings → Web dashboard → Office levels**, which applies at once.

### The badge

The level sits in a small badge on the top-left corner of each name tag. It overlaps the tag's edge and takes none of its width. Levels over 999 are written as 1.1k. The badge's colour follows the tier, using the dashboard's status colours:

| Levels | Colour | Default title |
|---|---|---|
| 0–9 | grey | Novice |
| 10–19 | green (`--ok`) | Apprentice |
| 20–34 | blue (`--accent`, tinted) | Adept |
| 35–49 | blue (`--accent`, filled) | Expert |
| 50–99 | gold (`--warn`) | Master |
| 100+ | red (`--danger`) | Legend |

When someone goes up a level, a short ring shows over their head, and the people in the same area (the same room in Desks) show a "!" as they glance over. Nothing is shown with reduced motion.

### The profile card

Clicking a person opens their card beside them. It's a popover, not a dialog: the Office keeps running and isn't dimmed, and the card follows the person if they walk off. Click the same person again, press Esc, or click anywhere else to close it; click someone else to switch to their card. On a phone the card is a sheet at the bottom of the screen; swipe it down to close it.

The card is 320 px wide and shows:

- Their idle picture in the office's style, with the badge; the display name; the instance name on one line (cut short, with the full name on hover); and the state with the title, such as "Working · Master".
- Two lines over the XP bar: "Lv 50 · 250M work tokens", then "10.1M to Lv 51". "(estimated)" follows the tokens when some of the work was Kiro's.
- The office and area, the model, the backend, today's work tokens and requests, and the day count since first seen.
- **Now:** the same activity line as the hover tooltip.
- **Find in office** pans and zooms to them; **Chat** opens their chat.

Rows the viewer may not see are left out: no token rows where the numbers aren't served (see above), and on a share link only the name, title, state, office and level.

### Titles from a skin pack

A pack can give its own titles and pin a title on someone:

```json
"levels": {
  "titles": [{ "from": 1, "name": "Intern" }, { "from": 20, "name": "Engineer" }, { "from": 50, "name": "Principal" }],
  "fixed": { "atlas": { "title": "Founder", "hideLevel": true }, "barista": { "title": "Coffee master" } }
}
```

- `titles`: up to 32 entries. Each `from` is 0–100000 and higher than the one before it, and each `name` is 1–24 characters. A level below the first entry keeps the default title.
- `fixed`: up to 500 entries. A key names an instance, or an NPC by its furniture `id`, and the entry's title shows whatever the level. With `hideLevel: true`, the badge becomes a small diamond mark, and the card shows the title without "Lv n" or the XP bar. An NPC's tag shows its label and its title with the mark; NPCs have no card.
- A share link gets a pinned title only for the people it shows, and for NPCs.

## Who can do what

| | Fleet admin, dashboard reached directly | Fleet admin, public link | Read-only session | Guest | Share-link viewer |
|---|---|---|---|---|---|
| See the Office | ✅ | ✅ | ✅ | ❌ | ✅ one office or all, read-only |
| Edit offices, upload or delete packs, Edit layout | ✅ | ❌ | ❌ | ❌ | ❌ |
| Approve agents' pack changes | ✅ | ❌ | ❌ | ❌ | ❌ |
| Share… and Revoke | ✅ | ✅ | ❌ | ❌ | ❌ |

A fleet admin can also approve a pending pack change with **Approve** on its notice in General.

## Reference

### The manifest

| Key | Required | What it is |
|---|---|---|
| `format` | ✅ | `1` |
| `id` | ✅ | 1–40 letters, digits, `_` or `-`. Not `pixel`, `studio` or `cozy`; ids that differ only in case clash |
| `scale` | ❌ | logical units per image pixel, 1–8 (default 2) |
| `background` | with `stateZones` | the scene's picture, 16:9 |
| `foreground` | ❌ | a 16:9 picture over the scene (with `stateZones` only) |
| `matte` | ❌ | `#rrggbb`, the colour around the scene |
| `areas` | with `stateZones` | `{ name: { rect: [x, y, w, h], seats: [seat, …] } }`, up to 32 areas and 64 seats each |
| `stateZones` | ❌ | state → area; `"default"` for the rest. Without it the pack keeps the Desks layout |
| `door` | ❌ | `[x, y]` where newcomers walk in (default bottom middle) |
| `mailDrop` | ❌ | `[x, y]` where letters from other offices land, such as a mailbox or a counter. Later letters wait 16 px apart to the right of it and step past any seat. Default: the waypoint nearest the middle that no seat is on |
| `waypoints` | ❌ | `[{ id, x, y }, …]`, up to 512 |
| `edges` | ❌ | `[[id, id], …]`, up to 2048 |
| `straight` | ❌ | `true`: every walk goes across, then up or down |
| `furniture` | ❌ | items, up to 128 (see [Furniture](#furniture)) |
| `characters` | ✅ | `{ set: { pose: STRIP, … } }`, up to 64 sets; `default` with `idle` required. Keys: `working`, `idle`, `paused`, `needs`, `walk`, `walkDown`, `walkUp`, `walkSide`, `prop` |
| `byInstance` | ❌ | instance name → character set, up to 500 |
| `props` | ❌ | `task`, `send`, `report`, `broadcast`: STRIPs for what flies |
| `bubbles` | ❌ | `{ "en" \| "zh-TW": { state: [line, …] } }`, up to 12 lines of 1–40 characters |
| `room`, `desk` | ❌ | Desks layout pictures: `room.floor`, `room.wall`, `desk.back`, `desk.front`, `desk.lit` |
| `levels` | ❌ | `{ titles, fixed }`: the levels' titles and pinned titles (see [Titles from a skin pack](#titles-from-a-skin-pack)) |

A seat is `[x, y]` or `{ "x", "y", "for": [instance, …] (up to 16), "lend": false }`, inside its area. Coordinates run 0–1280 across and 0–720 down. A name the pack declares can't be one every object already has (`constructor`, `toString`, `__proto__`, …).

### Strips

A STRIP is `{ "src", "frames", "w", "h", "fps", "ax", "ay", "dw", "dh" }`:

| Key | Range | Default |
|---|---|---|
| `src` | a file in the pack: letters, digits, `. _ - /`, no `..`, not starting with `/` | — |
| `frames` | 1–32, side by side, left to right, no gaps | — |
| `w`, `h` | 1–512 image pixels per frame | — |
| `fps` | 0–30; 0 shows the first frame only | 4 |
| `ax`, `ay` | the anchor in image pixels | bottom centre |
| `dw`, `dh` | the displayed size in logical units (1–1280, 1–720) | `w·scale`, `h·scale` |

### Furniture

| Key | What it is |
|---|---|
| `id` | a new name: letters, digits, `_`, `-` |
| `sprite` | its STRIP |
| `x`, `y` | where its anchor goes |
| `depth` | −10000–10000 (under 1000: under the people), or `"y"` (among them) |
| `activeWhen` | a state or a list of up to 8: it plays (or shows `activeSprite`) while someone is in it |
| `activeSprite` | its picture while active (needs `activeWhen`) |
| `activeFor` | an instance or a list of up to 8: only their state counts (needs `activeWhen`) |
| `loop` | `true`: plays its strip all the time when not active |
| `label` | a name tag under it, 1–40 characters |
| `night` | `{ sprite, x?, y? }`: how and where it sleeps at bedtime |
| `walk` | `{ walk, walkDown?, walkUp?, walkSide? }`: it strolls near its spot |
| `activeOn` | **Not released yet.** `"state"` (default) or `"seated"`: active only once its person has sat down (needs `activeWhen`) |
| `hides` | **Not released yet.** `true`: its people aren't drawn while it's active; their tags and bubbles go on it (needs `activeFor`) |

### Layout overrides

An office's `overrides` (written by Edit layout; checked on every `PUT /ui/offices`):

| Key | What it is |
|---|---|
| `pack` | the pack they were made on; on any other style they're ignored |
| `seats` | `{ area: [[x, y], …] }`: as many seats as the pack's, each inside the area |
| `furniture` | `{ item: [x, y] }` |
| `furnitureNight` | `{ item: [x, y] }`: a night place, for an item the pack gives a `night` |
| `seatFor` | `{ area: { "slot": { "for": [instance, …], "lend": false } } }`; `"for": []` undoes the pack's reservation |
| `door` | `[x, y]` |
| `mailDrop` | `[x, y]`: where letters land |
| `waypoints`, `edges` | the walking graph, replaced whole |

### Limits

| | Limit |
|---|---|
| Packs kept | 16 (plus one previous version each, kept for agents' restores) |
| Files in a pack | 160 |
| One file | 2 MiB, 4096 × 4096 px, PNG only (checked by signature, every chunk read, metadata stripped) |
| A whole pack | 20 MiB |
| The manifest | 64 KiB |
| All packs on disk | 640 MiB, previous versions included |
| Offices | 20; saves 20 a minute per person |
| Office share links | 10 open; 15 minutes to 24 hours; 120 requests a minute each |
| `office_set` | 6 calls a minute, 60 an hour per agent |
| Agents' pack changes | 20 batches and 200 MiB an hour per agent; a batch is up to 16 packs and 100 MiB |
| Agents' pack checks (`office_pack_check`) | 60 batches and 1 GiB as sent an hour per agent |

### Files and settings

| What | Where |
|---|---|
| Stored offices | `web-offices.json` in the AgEnD home (each office's layout, night places and seat reservations are kept beside the office list in the same file, by office id) |
| Skin packs | `web-office-skins/<id>/` (`pack.json`, the pictures; a previous version in `pack.prev.json`) |
| A deleted pack's kept previous version | `web-office-skins/.kept-<id>/` |
| Agents' pack changes | `web-office-skins/.agent-changes.log` (the log); `.agent-changes.json` (the approval mode) |
| Agent switches | `office_access`, `office_pack_access` (per instance, or `defaults.*`) in fleet.yaml; see [configuration.md](configuration.md) |
| Share links | `web.office_share.enabled` (default `true`), `web.office_share.max_hours` (1–24, default 24) |
| Levels | `web.office_levels` (default `true`); the carried lifetime total in `instances/<name>/usage-lifetime.json`, beside the usage history |
| Per-device choices | the view, style, filters, bedtime and Lobby tile (browser storage) |

## Upgrading and rolling back

- **Upgrading** keeps your offices, packs and layouts; nothing needs migrating by hand.
- **A pack with `levels` and rolling back.** A version before levels refuses a pack that has a `levels` key, so such a pack is drawn as Desks there, with a note. Remove the key, or re-upload the pack without it, if you need to roll back.
- **Levels and rolling back.** Versions before levels never open `usage-lifetime.json`, so a rollback keeps it. While an older version runs, though, it prunes days older than 400 without carrying them, and those days are missing from the level after you upgrade again. Nothing else is lost.
- **Rolling back within 2.3.2.** A pack deleted by an agent with `keep_previous` keeps its previous version in its own `.kept-<id>` folder, so a host rolled back to 2.3.2-beta.10 can still upload and delete that id. Since the fix for #2706 (**not released yet**), offices' layouts are kept beside the office list. A 2.3.2 beta from before that fix still shows every office after a rollback, but without its layout, and a save there drops the layouts.
- **Rolling back to 2.3.1 or 2.2.6.** `office_access` and `office_pack_access` are stored outside `dashboard` in fleet.yaml, so the older version accepts the file and ignores them. 2.2.6 has no Office. 2.3.1 has no skin packs: an office in a pack or in Cozy is drawn as Desks with a note. Every office's layout (Edit layout, night places, seat reservations) is kept beside the office list, where 2.3.1 doesn't look: there every office shows, without its layout, and a save on 2.3.1 drops the layouts for good. **Not released yet:** this needs the fix for #2706. On 2.3.2-beta.11 or earlier, the layout is inside the office's entry, so 2.3.1 doesn't show that office at all, and a save there deletes it. Either way, keep a copy of `web-offices.json` before rolling back if the layouts matter.
- **An office kept for nobody on an older version** (#2752, not released yet). An older version reads `["team:"]` as a team it can't find, so the office still shows nobody. Its Edit offices says **1 picked** with no box ticked; ticking someone there adds them, and the office then holds them.

## Versions

2.3.2 hasn't had a stable release yet; its features are in the betas listed here.

| Feature | First version |
|---|---|
| The Office view: Desks and Studio, stored offices, Edit offices, Find, Show and People | 2.3.0 |
| Skin packs, Edit layout, crowds and "+N", Hide paused and stopped | 2.3.2-beta.1 |
| Pan and zoom, Fit and Fill, fullscreen, `foreground`, `matte`, `depth: "y"` | 2.3.2-beta.1 |
| All offices and the Lobby tile | 2.3.2-beta.2 |
| Bedtime and furniture `night`; mail; idle strolls; furniture `loop`, `activeFor`, `label` and `walk`; a set's `prop`; faint figures in Edit layout; up to 16 packs | 2.3.2-beta.4 |
| `office_view` / `office_set` and `office_access` | 2.3.2-beta.4 |
| Edit offices in the right-hand panel; the scene centred | 2.3.2-beta.4 |
| 160 files and 20 MiB a pack; `straight` walking; Office share links | 2.3.2-beta.6 |
| Cozy | 2.3.2-beta.8 |
| Night places in Edit layout; share links load every pack picture | 2.3.2-beta.9 |
| Phone layout; seat reservations; agents managing skin packs (`office_pack_access`) | 2.3.2-beta.11 |
| Furniture `activeOn` and `hides` | **Not released yet** (after 2.3.2-beta.11) |
| Offices with a layout survive a rollback to 2.3.1 (#2706) | **Not released yet** (after 2.3.2-beta.11) |
| Whole fleet's style kept for everyone; Whole fleet as a share; a share's Look (#2715, #2716) | **Not released yet** (after 2.3.2-beta.14) |
| An office for nobody (NPCs only) (#2752) | **Not released yet** (after 2.3.2-beta.14) |
