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

The Hub keeps one copy per hash (`hub_agent_picture_files`). A row naming a held file with another type or size than it has is not recorded for that picture (a hash fixes its bytes, so it could never match): it shows nothing and keeps no file alive, so one agent never holds more than its cap. A room shows a picture only once the Hub holds it, so a changed picture never shows the old one meanwhile. A picture that lands, changes or goes emits `member.changed` to every room holding the agent: its open pages read the members again. Unsharing or revoking hides the pictures at once. A withdrawal is swept as its snapshot arrives; anything else retired (a revoked Fleet sends no report) is swept within a minute. A file another agent still shows is kept.

## Who can see them

`GET /hub/v1/rooms/<room>/agents/<exposure>/picture/disc|portrait` is for the room's members, and only for an agent in that room. Its headers:
- the content type sniffed at storage, `nosniff`, `default-src 'none'; sandbox`;
- an ETag;
- `private, max-age=86400` when `?v=` is the current hash, else `no-cache`.

The room's member detail and office state carry the hashes (`look.disc`, `look.portrait`; `picture` in the office state), never bytes.
