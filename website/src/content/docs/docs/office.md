---
title: Office
description: The fleet as a small pixel office on the web dashboard — styles and skin packs, offices for teams, Edit layout, share links, levels and agents that take part.
---

**Fleet → Org chart → Office** on the [web dashboard](/AgEnD/docs/web-guide/) draws your fleet as a small pixel office. Each agent is a little person whose pose is its state, and the messages, delegations and reports between agents travel across the room. This page is the short version; the full guide, with the skin-pack format and every limit, is [The Office view](https://github.com/songsid/AgEnD/blob/main/docs/office.md) in the repository.

The Office came in 2.3.0 with the Desks and Studio styles. Skin packs, Cozy, Edit layout, All offices, share links and levels came in 2.3.2.

## Look around

| State | Pose |
|---|---|
| working | typing at the desk |
| idle | a tea break (in Studio, Cozy or a zones pack: the lounge) |
| paused, stopped | asleep |
| needs you, crashed, looks stuck | a raised hand |

- **Move around:** drag to pan; the wheel or a pinch zooms. **Fit** shows the whole scene, **Fill** fills the panel and crops the rest. `+`, `-`, `0` and `f` (fullscreen) work while the office has focus.
- **People:** hover for a name, state and backend. Click someone, or press Enter on their desk-list entry, for their profile card; double-click to open their chat.
- **The Office bar:** which office to show (**Whole fleet**, a stored office, or **All offices** once two are stored), a team or the Lobby only, pinned people, the style, and **Hide paused and stopped**.
- **On a phone** the scene takes the height under the bars, and the zoom buttons are a row along its top.

## Styles and skin packs

- **Desks:** a room per team, a desk per agent.
- **Studio:** one scene with four areas (Work, Lounge, Help desk, Nap corner); each agent walks to the area for its state.
- **Cozy:** the same kind of scene in a warm pixel-art room that ships with AgEnD. It's the default for a new office and a browser that hasn't picked a style.
- **A skin pack** is an artist's pictures: a `manifest.json` and PNG files. A fleet admin uploads one in **Edit offices → Skin packs**; the host checks it and keeps it unchanged. Kept packs appear in every Style picker. Making one is described in [Make a skin pack](https://github.com/songsid/AgEnD/blob/main/docs/office.md#make-a-skin-pack).

A fleet admin's style for **Whole fleet** is what every device and share link shows. Anyone else may pick a style for their own browser.

## Set up offices

A fleet admin, on the dashboard reached directly, uses **Edit offices** in the Office bar:

1. **Add office** and name it.
2. **Who is in it:** **Everyone**, **Picked** (whole teams or single agents), or **Nobody (NPCs only)** for a room with only its style's characters.
3. **Style:** Desks, Studio, Cozy or a kept skin pack.
4. **Save.**

Everyone on the fleet sees the same offices. The host keeps them in `web-offices.json` in the AgEnD home, never in fleet.yaml, so a change restarts nothing.

**Edit layout** (Studio, Cozy or a zones pack) moves seats, furniture, the door, the mail drop and the walking paths for one office, reserves seats for particular agents, and gives furniture a night place. The pack itself stays as uploaded. See [Arrange the layout](https://github.com/songsid/AgEnD/blob/main/docs/office.md#arrange-the-layout).

## Share a view

**Share…** in the Office bar makes a link anyone can open with no sign-in, for 15 minutes to 24 hours (1 hour by default): **Whole fleet**, one office or **All offices**, in a light or dark look or the viewer's own. Viewers see the scene, names, identity colours and states, updated every 5 seconds — no chat, settings, models or costs. At most 10 links are open at once; revoke them in **Settings → Access & security → Office share links**. See [Share a view](https://github.com/songsid/AgEnD/blob/main/docs/office.md#share-a-view).

## Levels

Each agent has a level from its lifetime work (uncached input, cache writes and output; cache reads don't count), shown as a badge on its name tag and on its profile card. The numbers come from the usage report; nothing new is collected. **Settings → Web dashboard → Office levels** turns them off. See [Levels](https://github.com/songsid/AgEnD/blob/main/docs/office.md#levels).

## Agents in the office

With the **Office** dashboard feature on for an agent (`office_access: true`, off unless a person sets it), it can see the offices it's in and walk, say a short line or hold a pose for a moment (`office_view`, `office_set`). A separate switch, **Office skin packs** (`office_pack_access: true`), lets an agent check, upload, replace, delete and restore packs; by default each change waits for a fleet admin's yes. See [Agents in the office](https://github.com/songsid/AgEnD/blob/main/docs/office.md#agents-in-the-office).

## Rolling back

Offices, layouts and packs carry over an upgrade. On a rollback to 2.3.1 every office still shows, without its Edit layout changes; keep a copy of `web-offices.json` first if the layouts matter. See [Upgrading and rolling back](https://github.com/songsid/AgEnD/blob/main/docs/office.md#upgrading-and-rolling-back).
