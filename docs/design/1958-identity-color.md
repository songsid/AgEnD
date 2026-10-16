# #1958: a person-picked identity colour per instance, shown where you scan

Status: design note, for decision. It targets 2.3.0 on `feat/2.3-web-mod` and is folded into the #1629 identity work.

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

### 1. One colour per instance, resolved in a fixed order

The order runs from the person's pick to an automatic fallback:
1. **A person's pick**, stored with the identity card: a new `color` field in `instance_card`, set like `card_tagline`.
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

- **Store:** `HumanCardStore` (`instance_card` in `profiles.db`) gets a `color` field (TEXT, null when unset), added in place for existing databases. The value is either `preset:<id>` or `#rrggbb`; anything else is refused with a 400.
- **Write:** `POST /api/profile/<name>` takes `color` (a preset id, a hex value, or `null` to clear), next to `card_tagline`.
  - It is allowed wherever profile and card edits are, the public link included, following r4.1 Q2 ("the identity card follows the profile and avatar").
  - After a write, the server sends a status event so other devices repaint. Today's profile writes don't, so this fixes that as well.
- **ClassicBot rooms** take the same path; `isKnownInstance` already includes them.
- **Mods (#1629):** a person's export carries the person's colour with the identity defaults, and an import offers it. An agent's export never carries a person's pick.
- **Accessibility:** colour is never the only cue, since the names stay. Name text always meets 4.5:1. The ring and bar meet 3:1, or the preset variant does.

## Decisions needed

1. **Default placement:** keep today's look (ring only), or make the colour visible by default (ring + accent bar)? *My recommendation:* ring + accent bar, since visibility is the point of the request.
2. **Who the setting belongs to.** Host-wide like `card.size` (simple: one value for everyone signed in as the host), or per person? Per person needs the person-scope rules in `web-prefs` widened beyond effect ids, which is Sol's area. *My recommendation:* host-wide now, per person when the person-scope rules are widened.
3. **Public link:** may change colours, like profile and card edits? *My recommendation:* yes, for consistency with r4.1 Q2.
4. **Automatic colours for everyone:** instances that show no ring today get one from the hash tier. *My recommendation:* yes; that is how rooms and emoji faces become distinguishable.

## Plan (on `feat/2.3-web-mod`, after these decisions)

- **PR A, the server:**
  - the store column and validation;
  - `identityColor()`, its tiers and the hash fallback;
  - the palette module with contrast-checked variants (tested);
  - the `/api/profile` field, the status-frame field and the status event after writes;
  - `get_web_appearance`, tests, and docs EN/zh-TW.
- **PR B, the page:**
  - the shared resolver (`fx.show`), and the ring for every face;
  - the bar and the name tint, and the header dots;
  - the Color dialog in Chat ⋯, Details ⋯ and Edit profile;
  - the Settings → Appearance setting, strings EN/zh-TW, the skill, a fragment, and a Chromium smoke test in both themes.
