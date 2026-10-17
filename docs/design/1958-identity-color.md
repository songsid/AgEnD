# #1958: a person-picked identity colour per instance, shown where you scan

Status: decided (the user's answers, 2026-10-17); PR A merged (#1966), PR B in progress. It targets 2.3.0 on `feat/2.3-web-mod` and is folded into the #1629 identity work.

## What exists today (on `feat/2.3-web-mod`)

**The ring is drawn in one place only: the sidebar row** (`instance-nav.js` `InstanceAvatar`, `.av.ring`).
- It appears only when the face is a picture.
- Its colour is the agent's theme accent (`theme_accent`, when themes are shown); otherwise the bot's colour from its highest coloured Discord role (`accent`).
- The role colour counts only for a bot of the instance's own: "a shared bot's would ring everyone alike."
- The chat header, Details, View, the org chart and Needs-you show no colour.

**Rooms almost never get a colour.** ClassicBot rooms usually share one bot, and Telegram has no role colours. A face that is an emoji or a letter never gets a ring.

**No person can set a colour.** People can edit the identity card (tagline, bio, portrait, banner). Those edits use a person-over-agent pattern that fits this change exactly: `HumanCardStore` keeps them in `profiles.db`, and `resolveCard` lets the person's value win field by field.

**Sidebar rows have no ⋯ menu.** The ⋯ menus are in the Chat and Details headers; profile edits are in View's Edit profile dialog.

## Proposal

*The first proposal, as posted. Where the user's decisions below differ, they win.*

### 1. One colour per instance, resolved in a fixed order

The order runs from the person's pick to an automatic fallback:
1. **A person's pick**, set from the same places as the identity card (`color`, next to `card_tagline`), stored in its own table.
2. **The agent's theme accent** (#1629 `theme.accent`), only while this device shows themes (`fx.show`, not safe mode), as today.
3. **The own bot's Discord role colour**, under today's own-bot rule.
4. **Automatic:** one of the 12 palette colours, chosen by a stable hash of the instance's name (FNV-1a), so it never changes between reloads. Every instance and every room gets one.

The pick is shared host-wide, like the profile and the card: everyone who views the dashboard sees the same colour. **Reset** clears the pick, and the next tier shows again.

**The server resolves it** in one function, `identityColor(name)`, and sends it in the status frame as `color: { value, source, preset? }`, where `source` is `person`, `agent`, `role` or `auto`.
- The theme tier depends on a per-device setting (`fx.show`). So the frame carries the agent's colour separately, as today's `theme_accent`.
- The page drops that tier when themes are hidden, with the same function in a shared module (no duplicated rules).
- `get_web_appearance` tells the agent which colour is in force and where it came from.

### 2. A palette that reads in both themes, plus custom hex

- **Presets:** 12 named presets: red, orange, amber, lime, green, teal, cyan, blue, indigo, violet, pink, slate.
  - Each has a light-theme and a dark-theme value, chosen to reach at least 3:1 against `--bg` for the ring and bar, and at least 4.5:1 for name text.
  - The stored value is the preset id, so the page draws the variant for its theme.
- **Custom hex:** `#rrggbb`, checked with `canonicalColor`. It is used as-is for the ring and bar.
  - For name text it is adjusted per theme: lightened or darkened in steps until it reaches 4.5:1. The page never shows unreadable names.
  - The dialog says so: "names use a readable shade of it".

### 3. Where it shows: one setting with three choices

The setting is **ring only** / **ring + accent bar** / **ring + name**:
- **ring:** the avatar ring, now for every face, including emoji and letters.
- **accent bar:** a 3 px bar at the row's left edge. The active row keeps its own highlight.
- **name:** the name text, in the readable shade.

Whatever the setting, the colour also shows as a small dot before the name in the **chat header** and the **Details header**, so the instance you're in is marked too.

Message bubbles stay with the agent's theme (`bubble`). Colouring them by identity would compete with it. This is a possible later step, not v1.

### 4. Where you set it

- **Chat ⋯ and Details ⋯ → Color…** opens a small dialog with:
  - the 12 swatches, plus a hex field and the browser's colour picker;
  - a live preview of the sidebar row;
  - where the current colour comes from ("From the agent's theme", "From the bot's Discord role", "Automatic");
  - **Reset**.
- **View → Edit profile** gets the same control next to the avatar, because a colour belongs with the face.
- **Settings → Appearance** gets the "where it shows" setting.

### 5. Server, API and rules

- **Store:** its own table in `profiles.db`, `instance_color (instance_name, color, updated_at)`. It is kept apart from `instance_card`, so "Clear card" leaves the colour alone, and an older AgEnD reading `profiles.db` sees only what it knew. The value is either `preset:<id>` or `#rrggbb`; anything else is refused with a 400, and a status read never creates the database or the table.
- **Write:** `POST /api/profile/<name>` takes `color` (a preset id, a hex value, or `null` to clear), next to `card_tagline`.
  - It is allowed wherever profile and card edits are, the public link included, following r4.1 Q2 ("the identity card follows the profile and avatar").
  - After a write, the server sends a status event so other devices repaint. Today's profile writes don't, so this fixes that as well.
- **ClassicBot rooms** take the same path; `isKnownInstance` already includes them.
- **Mods (#1629):** a person's export carries the person's colour with the identity defaults, and an import offers it. An agent's export never carries a person's pick.
- **Accessibility:** colour is never the only cue, since the names stay. Name text always meets 4.5:1. The ring and bar meet 3:1, or the preset variant does.

## The user's decisions (2026-10-17)

1. **Default placement:** ring and the left accent bar.
2. **Per instance, all three places:** each instance can show its colour on its **name**, its **left bar** and its
   **ring**, in any combination. Agents help set it: the theme's `identity: { color?, show? }` (`set_web_theme`), and
   `get_web_appearance` reports the colour, where it shows, whose choice each is, and whether colours are off. A
   person's choice wins, field by field; Reset clears it. A host-wide default applies where nobody chose.
3. **The public link may change colours,** as it may profile and card edits.
4. **Automatic colours:** a few soft, low-saturation colours (8: sand, clay, rose, plum, dusk, sea, moss, slate), like
   Telegram's and Discord's default avatar colours, chosen by a stable hash of the name. Duplicates are fine. Each reads
   at 4.5:1 on the page and the sidebar, light and dark.
5. **Settings → Web appearance (網頁外觀):** the Appearance tab, renamed and holding every appearance setting:
   - what it holds now: themes and effects shown, card size, the sidebar widget, custom CSS, mods, effects, this
     device's CSS switch, and the card limits;
   - plus the colour's default places, and **Turn off colours** (`color.off`: none drawn anywhere on this host; every
     pick is kept, so turning them back on restores them);
   - plus **Restore defaults**, which asks first, says what it resets, and resets the host's appearance settings
     (`fx.show`, `card.size`, `card.sizeByInstance`, `widget.sidebar`, `color.show`, `color.off`) and turns this
     person's custom CSS off (its versions are kept).
   - Restore defaults leaves alone what is not a setting: the colours people picked per instance, installed mods,
     uploaded effects and the fleet's card limits.
   - Theme, language and names stay in Preferences: they are this device's basics, synced, and not about agents' looks.

## How it is built

- **Resolution.**
  - The colour: a person's pick, then the agent's (`theme.identity.color`, else its `accent`; only while themes are
    shown), then the own bot's role colour, then automatic.
  - The places: a person's choice, then the agent's (themes shown), then the host's `color.show`, then ring + bar.
  - `color.off` draws nothing.
- **Store.** `profiles.db` `instance_identity (instance_name, color, show, updated_at)`. The first cut's
  `instance_color` rows carry over once.
- **Profile write.** `POST /api/profile/<name>` takes `color` and `color_show`. Card text, the colour choice and the
  profile row are written in one transaction.

## Plan (on `feat/2.3-web-mod`)

- **PR A (#1966, merged):** the store, the resolver, the palette, the profile field, the status-frame tiers and `get_web_appearance`.
- **PR B1, the server:**
  - the decisions' model: the automatic palette, per-instance places in the store and in `color_show`, the theme's
    `identity`, and the `color.show` / `color.off` prefs;
  - the placements' resolution, `get_web_appearance`'s places and off switch, and the one-transaction profile write
    (Fable #1966 P3);
  - the skill and the design note.
- **PR B2, the page:**
  - the shared resolver, the ring for every face, the bar and the name tint, and the header dots;
  - the Color dialog (a colour plus three places, and Reset) in Chat ⋯, Details ⋯ and Edit profile;
  - Settings → Web appearance: the renamed tab, the colour card, Turn off colours and Restore defaults;
  - strings EN/zh-TW, docs, a fragment, and a Chromium smoke test in both themes.
