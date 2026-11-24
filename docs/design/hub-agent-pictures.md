# Shared agents' pictures on the Hub (M-3533 R2b)

Design: [hub-office-visit.md](hub-office-visit.md) §2.3 and "Decided while building": each place shows what the Fleet shows in
the same kind of place. This is the server half (R2b-server). The page half (R2b-page) draws the pictures and turns the feature on.
Until then the Hub does not offer it, so no Fleet sends anything and no page changes.

## What a Fleet sends

For each **published** share, two pictures at most:

| Picture | On the Fleet | Kept for the Hub |
|---|---|---|
| **disc** | The sidebar's avatar (instance-nav.js `avatarOf` over `webIdentityImage`): a profile picture uploaded in View, else the agent's theme avatar while the owner shows agents' themes (`fx.show`), else its bot's avatar, else a Discord custom persona emoji. A Unicode emoji or an initial is no picture: the catalog's emoji (R2a) stays. | The centred square (CSS `object-fit: cover`), 64 px |
| **portrait** | The identity card's picture: a person's, else the agent's own | The square the office card draws, 18% down (fleet-office-card.js `drawPortraitAvatar`), 256 px |

- **Reducing.** AgEnD has no image library. Only a PNG is reduced, by `src/web-png.ts` in a worker thread (`src/hub-picture-reduce.ts`, with its own heap and a 10 s deadline). A JPEG, webp or GIF goes as it is when it fits.
- **Caps** (512 KB an agent): the disc up to 64 KB; the portrait in what the disc leaves. A picture over its cap is left out and its row says `tooLarge`. Only the owner's own `/hub/v1/me/agents` shows that. The disc is never the one dropped.
- **Never sent:** file names or paths, other agents, settings, the skin pack.

## The exchange (`agent-pictures-v1`)

The capability is offered in the welcome only: it takes no hello slot, and only members that take a 32-name welcome are offered it. A member's first `agent.pictures` is its opt-in.

1. The member polls every 5 s by cheap keys (a file version or a content id). When a key changes it sends `agent.pictures`: `{ revision, agents: [{ exposureId, disc, portrait, tooLarge? }] }`, each picture `{ sha256, mime, size }`.
2. The Hub replaces that Fleet's rows. It skips any row that is not this Fleet's published share. It drops every file no row names, then answers `agent.pictures-result { ok, need }` with the hashes it does not hold.
3. The member sends each needed picture as `agent.picture` chunks of 180 KiB (`{ sha256, mime, size, index, count, data }`). Each chunk is answered with `agent.picture-result`. The Hub stores a picture only when:
   - the hash matches;
   - the bytes are the type named;
   - a row of this Fleet names it with exactly that type and size (the caps were checked on that row).
   A refusal leaves the report unsent, so the next tick tries again.

The Hub keeps one copy per hash (`hub_agent_picture_files`). A file lives only while some row names it as it is, with its type and size; a reference declaring it otherwise (a hash fixes its bytes, so it could never match) shows nothing and keeps nothing alive, whatever order the reports and uploads come in. A report also drops such a reference to a file already held. So one agent never holds more than its cap. A room shows a picture only once the Hub holds it, so a changed picture never shows the old one meanwhile. A picture that lands, changes or goes emits `member.changed` to every room holding the agent: its open pages read the members again. Unsharing or revoking hides the pictures at once. A withdrawal is swept as its snapshot arrives; anything else retired (a revoked Fleet sends no report) is swept within a minute. A file another agent still shows is kept.

## Who can see them

`GET /hub/v1/rooms/<room>/agents/<exposure>/picture/disc|portrait` is for the room's members, and only for an agent in that room. Its headers:
- the content type sniffed at storage, `nosniff`, `default-src 'none'; sandbox`;
- an ETag;
- `private, max-age=86400` when `?v=` is the current hash, else `no-cache`.

The room's member detail and office state carry the hashes (`look.disc`, `look.portrait`; `picture` in the office state), never bytes.

## R2c: the agent's own character (`agent-characters-v1`)

Design: [hub-office-visit.md](hub-office-visit.md) §2.3, "its own character pictures from the owner's skin pack, when the pack
gives it some". Decided with Lumen while building (11-24, all six as recommended, with conditions):

1. **Which character is its own.** Only a set the owner gave the agent by name, the pack's `byInstance`; a pack's `default` is
   nobody's own. The pack is that of the first office in the owner's own office order that holds the agent and whose pack
   names it; else the page's own "All" office's pack (`autoSkin`). If two offices name different sets, the first wins and
   nothing else is sent (`src/hub-character-plan.ts` `ownCharacter`). With none, the agent stays the style's figure
   in its colour (R2a).
2. **What is sent.** That one set, only the poses a room office shows: `working`, `idle`, `paused` (offline and later draw as
   paused, as the Fleet draws stopped), `stand` (the card), and the walks (`walk`, `walkDown`, `walkUp`, `walkSide`,
   `walkLeft`). Never `needs` (a room has no such state), `eat`, `dragged`, `pat` (no Pat or Feed in rooms) or `prop`.
   - A missing `working`, `paused` or `stand` is filled inside the set from `stand`, else `idle`; a missing `idle` from
     `stand`. A set with neither `idle` nor `stand` is not sent. A missing walk is the Fleet's own fallback, walk then idle.
     So an agent is drawn wholly with its set or wholly as the figure.
   - Each pose is cut into its own PNG, its frames side by side (`src/hub-picture-reduce.ts` `cropCharacter`, in the worker):
     a pack's shared sheet never crosses. A pack picture that is not a PNG, or does not decode or cut, sends no set at all.
     A pose of more than 32 frames sends no set.
   - Sent with each strip: its hash, type and size, and the pack's playback and placement fields (frames, w, h, fps,
     durations, once, loopFrom, ax, ay, dw, dh). Never a file name, the pack, its name, the scene or other sets.
3. **Cap.** The set has what the avatar and portrait leave of the 512 KB, counting each picture once (a filled pose shares
   its source's). It is all or nothing: one that does not fit is dropped whole, first, and the row says `tooLarge:
   ["character"]`; the owner's My agents row says so.
4. **Drawing.** The Fleet's office draws a pack strip at the size its pack gives (`dw` × `dh`) with no further limit. A room's
   built-in style has no pack scale, so the page draws it at most 88 × 96 scene units (a built-in desk cell's width, a pack
   character's suggested height), in proportion, never larger (`hub-room-office.js` `CHARACTER_FIT`). The name tag and its
   colour stay as R2a. The card shows the portrait, else the set's `stand`, else the figure. An agent's set is drawn only
   once all its pictures have loaded.
5. **Follows the owner** as the pictures do: the source's key is the pack's version and the set's name, so a changed pack,
   `byInstance` or office changes it with no re-share; unsharing removes it.

### The exchange

- The Hub offers `agent-characters-v1` beside `agent-pictures-v1`, in the welcome only, like it (a 32-name welcome). A member
  that took the offer sends `character` on its `agent.pictures` rows (`{ <pose>: { sha256, mime: "image/png", size, …fields } }`)
  and `"character"` in `tooLarge`. An older Hub's strict row never sees either; a Hub that did not offer it refuses a report
  naming one (`incompatible`).
- The strips go as `agent.picture` chunks, as the pictures do, kept once per hash in `hub_agent_picture_files`. The Hub keeps a
  set in `hub_agent_character_strips` (migration `s3-agent-characters`), one row a pose, whole: a strip held already with
  another type or size than declared drops the set. A room shows it only when every strip is held; a file lives only while
  some row names it as it is.
- **One frame.** A report must fit the link's 256 KiB frame (a refused one would be sent unchanged on every tick), and a
  report replaces the Fleet's rows, so none may be left out: every row keeps its disc and portrait, and whole character
  sets are left out from the last row back until it fits (`fitReport`). Such a set is not "too large" (the agent's own cap
  is not why); it is sent when the report has room. The report's revision hashes the rows' own JSON (Prism #4421).
- `GET /hub/v1/rooms/<room>/agents/<exposure>/character/<pose>` serves one strip, to the room's members only, with the
  picture route's headers.
