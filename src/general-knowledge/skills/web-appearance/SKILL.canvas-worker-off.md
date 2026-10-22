---
name: web-appearance
description: How you look on the AgEnD web dashboard — check it, change your own theme, identity card, identity colour and widgets, set an ambient effect (falling petals, click stars), and preview the result; and, for General, changing Settings → Web appearance for the user
roles: [general, worker, classic]
---

## What it is

People see you on the web dashboard: in the sidebar, at the top of your chat, on your Details page and in View. You
can shape how you look there — **only your own look, and only on the surfaces that are yours**:

| Surface | What you set | Tools |
|---|---|---|
| Your name and role line | display name, description | `set_display_name`, `set_description` |
| Your status stamp | persona emoji | `set_persona_emoji` (see the `persona-emoji` skill) |
| Your chat | theme: colours, accent, bubbles, font, background picture, working label | `set_web_theme`, `set_web_theme_asset` |
| The whole page, while your chat is open | your theme's colours on the sidebar, the header, the usage rail (a phone: the drawer, the header, the tabs) — colours only | `set_web_theme` (`page`) |
| Your face and ring | theme picture and accent | `set_web_theme`, `set_web_theme_asset` |
| Your identity card | portrait, banner, tagline, bio | `set_web_theme` (`card.*`), `set_web_theme_asset` |
| Your identity colour | the colour people find you by in the sidebar, and where it shows (name, bar, ring) | `set_web_theme` (`identity`) |
| Your chat header strip and Details page | widgets: small panels of facts the dashboard draws | `set_web_widget`, `remove_web_widget` |
| An ambient effect in your chat | falling petals, snow, rising lanterns, twinkles, stars where a person clicks — data only, drawn by the dashboard | `set_web_ambient`, `clear_web_ambient` |

None of these tools takes a target: they always act on you. You can't change another instance, the dashboard's own
chrome (beyond your colours on it while your chat is open), a person's sidebar widget, or a person's custom CSS.

## For the user: Settings → Web appearance (General, coordinators, full)

If you are General (or a coordinator or full profile), you can change the user's **Settings → Web appearance** for
them, exactly as the page changes it: the same checks, the same refusals. Custom CSS keeps its safe rules: no remote
URLs, assets only as `url("asset:<id>")`, at most 64 KiB. Other instances can't; they shape only their own look (the rest
of this skill).

1. **Read first:** `get_web_settings` returns a `summary` in plain words (tell the user from it), the values, and
   `people`: the host operator and everyone who has signed in. Host settings are everyone's on this host. Custom CSS is one person's own: pass `person` as the entry whose id is the user's (`person:<adapter>:<their id>`),
   else the host operator's are changed.
2. **One change per call:** `set_web_settings({ person?, change })`, where `change.what` is one of:

| `what` | Changes | Example |
|---|---|---|
| `host` | `themes_shown`, `card_size` (s/m/l), `card_sizes` ({instance: s/m/l}), `page_colours` ({instance: page/chat}), `colour_places` (name/bar/ring), `colours_off`, `sidebar_widget` ({spec, data}) — null puts one back to its default | `{ what: "host", set: { colour_places: ["name","ring"] } }` |
| `agent_colour` | one agent's colour (`preset:<name>` or `#rrggbb`) and places; null resets each | `{ what: "agent_colour", instance: "atlas", colour: "preset:teal" }` |
| `page_colours` | where one agent's theme colours go: `page` (the whole page), `chat` (only its chat) or `agent` (its own `page.on`) — as ⋯ → Page colours sets it | `{ what: "page_colours", instance: "atlas", choice: "chat" }` |
| `banner_focus` | which part of one agent's cropped card banner stays in view: `focus` 0 (top) … 100 (bottom), 50 the centre; it wins over the agent's own `card.bannerFocus`; null follows the agent's again | `{ what: "banner_focus", instance: "atlas", focus: 20 }` |
| `custom_css` | `save` (with `text`): goes **on trial**. It waits until they open the dashboard (up to 10 minutes; never opened, it goes back unseen), then goes back by itself 20 s after it is on their screen unless kept (#2198). `keep` (with `trial`: the id `save` returned — a different trial on now, say one they saved on their page since, is refused with `trial_mismatch`, never kept instead; or, kept after that 20 s ran out, it is put back in force as `use` of it), `revert` (the trial), `use` (with `version`: an earlier saved one, at once), `off` | `{ what: "custom_css", action: "save", text: "…" }`; tell them to open the dashboard and look, then `keep` (with that `trial`) only when they say so — a `keep` that comes too late (`not_on_trial`) means use `use` with the version from `get_web_settings` |
| `ambient` | one agent's ambient effect, set for the user: `ambient` is the same spec as `set_web_ambient`'s (it replaces the one of its kind, and the agent can't change it after); `ambient: null` clears (`which`: `loop` or `click`, default both) | `{ what: "ambient", instance: "atlas", ambient: { preset: "fall", glyphs: ["🌸","❀","✿"] } }` |
| `restore_defaults` | the host settings back to their defaults, and the person's custom CSS off | |

3. **Say what changed** in the user's words (read again if unsure). A refusal says why: the same words the page would
   show.

**Only the person can do these, on the page:**
- choose a file from their computer: add a CSS asset or a card picture;
- this browser's own switches: custom CSS off on this device, pausing effect playback;
- the card upload limits (fleet configuration; a raise waits for an admin's confirmation).

## Look first

- `get_web_appearance` — how you appear **now**, resolved exactly as the dashboard resolves it: your face and where it
  comes from (`profile`, `theme`, `bot`, `emoji` or `initial`), your ring colour, your **identity colour**
  (`identity_color`: the colour people find you by in the sidebar, its `source` — `person`, `agent` (your theme's
  `identity.color`, else its `accent`), `role` (your own bot's Discord role) or `auto` — its `light` / `dark` values,
  where it shows (`show`: `name`, `bar`, `ring`) and whose choice that is (`show_source`: `person`, `agent` or `host`),
  and `off` when the host turned colours off), your card field by field
  (each marked `human` or `agent`), your theme per light/dark mode after the defaults, whether a person locked it, and
  your limits.
- `preview_web_appearance` (`modes`: `["light"]`, `["dark"]` or both) — draws that as an SVG per mode into
  `.agend/appearance/<mode>.svg` in your working directory, with the pictures it shows written beside it
  (`avatar.png`, `portrait.png`, …), and returns both lists of paths. Read the SVGs for exact colours, geometry and
  text, and the pictures as images. Only your own pictures are there.
- `get_web_theme` — your stored theme, the token defaults it is drawn over, your uploaded pictures (`id`, `slot`), and
  `limits` (changes left, each picture slot's size limits, your picture quota).

## What wins over what

- **A person's choices win.** A picture uploaded for you in View beats your theme picture. A person's card field (from
  View's Edit profile) beats yours, field by field — leave it to them. A person can **Lock** your theme (every change
  you try is refused with `locked`) or **Reset** it (your theme, card and pictures go; a lock stays).
- A widget **a person placed** in one of your slots takes your values (`data`), but you can't replace or remove it
  (`person_placed`).
- **Each viewer decides what they see.** Anyone can turn agents' themes and widgets off for their own screens, and
  `?safe=1` loads a page without them; they then see the default look, no widgets, and your face follows the usual order without your theme
  picture — a picture a person uploaded for you, else your bot's avatar, your persona emoji or your first letter.
  Don't rely on your theme to say something important.
- The fleet can turn agent changes off entirely (`web.themes.agent_edit: false`): every change is refused with
  `theme_editing_off`; what you stored stays.
- A person can switch these tools off for you (`dashboard.appearance: false`; the person's web settings tools with
  `dashboard.web_settings: false`): a call is refused saying so. Do not retry; tell them if you need it.

## Change your theme

`set_web_theme { set?, clear? }` — all or nothing; `set` merges into your current theme, `clear` removes dotted paths.
Typed values only; anything else is refused with `{ errors: [{ path, problem }] }`:

- `colors.light` / `colors.dark`: any of `bg`, `surface`, `text`, `text2`, `accent`, `userBubble`, `agentBubble` as
  `#rrggbb` (or `#rgb`). **Contrast is checked per mode**: `text` at least 4.5:1 on `bg`, `surface` and both bubbles;
  `text2` at least 4.5:1 on `bg` and `surface`; `accent` at least 3:1 on `bg` — a palette that fails is refused, naming
  the pair.
- `accent`: `#rrggbb` for both modes (a mode's own `accent` wins). Without `identity.color`, it is also your identity
  colour.
- `identity`: `{ color?, show? }`: your identity colour and where it shows.
  - `color` is a preset (`red`, `orange`, `amber`, `lime`, `green`, `teal`, `cyan`, `blue`, `indigo`, `violet`, `pink`,
    `slate`, each readable in light and dark) or `#rrggbb`.
  - `show` is a list of `name`, `bar` and `ring` (`[]` for nowhere). Left out, the host's default applies (name, bar and ring).
  - A person's choice for you in the dashboard always wins, field by field, and their Reset brings yours back.
    `get_web_appearance` says which is in force.
- `page` (#2196): `{ on?: true | false, sidebar?: { light?, dark? } }` — `on: true` puts your colours (bg, surface, text,
  text2, accent; the sidebar's own colour per mode in `sidebar`, else your `bg`) on **the whole page while your chat,
  View, Log or Details is open**: the sidebar, the header, the usage rail; on a phone the drawer, the header and the
  tabs. Colours only: never fonts, pictures or layout, and **AgEnD's status colours** (the Needs you count, the state
  dots, errors, the focus ring — `get_web_theme`'s `status_colors`) are never yours to change. With `on: true` the
  contrast check adds: `text` and `text2` 4.5:1 and `accent` 3:1 on the sidebar, and every status colour 3:1 on the
  sidebar and on `bg`. A person's choice for you (⋯ → **Page colours**: your choice, the whole page, only your chat)
  wins; viewers with agents' themes off or `?safe=1` see the page's own look.
- For a person's **custom CSS** (#2199): while an agent's Chat, View, Log or Details is open, `<body>` has
  `data-agent="<instance name>"` (none elsewhere), set in the same render as the page — so a person's stylesheet can
  follow the open agent: `body[data-agent="atlas"] { --bg-sidebar: … }`. It is the person's, not yours to set.
- `bubble`: `{ radius: 0..24, border: "none" | "thin" | "accent" }`.
- `font`: `"inter"`, `"system"` or `"mono"`.
- `background`: `{ image: <asset id>, fit: "cover" | "contain", opacity: 0.05..1 }`.
- `avatar`: an asset id — your face (below a person's upload).
- `workingLabel`: 1..24 characters on one line, shown while you work instead of "is working…".
- `card`: `{ portrait?, banner?, tagline?, bio?, bannerFocus? }` — see below.

Example:

```json
{ "set": { "accent": "#7c3aed", "colors": { "dark": { "bg": "#14121f" } }, "bubble": { "radius": 12, "border": "accent" },
  "font": "inter", "workingLabel": "Reviewing" } }
```

`reset_web_theme` puts your theme back to the default (it counts as a change).

## Pictures

`set_web_theme_asset { slot, file }` — `file` is a picture in **your working directory** (no symlinks; read on your side,
never by path on the fleet). It returns `{ id }`; name that id in `set_web_theme`. Metadata such as GPS is removed, and
the id is the hash of what is kept, so the same picture is the same id.

| Slot | Types | Limits |
|---|---|---|
| `background` | png, jpeg, webp, gif | 512 KiB, 4096 px a side |
| `avatar` | png, jpeg, webp, gif | 256 KiB, 4096 px a side |
| `portrait` | png, jpeg, webp | set by the fleet (default 1024×1536, 1.5 MiB) |
| `banner` | png, jpeg, webp | set by the fleet (default 1600×600, 768 KiB) |
| `glyph` | png, webp, gif | 64 KiB, 128 px a side; at most 4 (for `set_web_ambient`'s `glyphs`) |

A picture holds one slot: upload it again for another slot only if it is a different picture. `get_web_theme`'s
`limits.asset_slots` has the limits in force and `limits.asset_quota` how many pictures you may keep. A picture your
theme stops naming is deleted.

## Your identity card

`card.tagline` (one line, 1..60 characters), `card.bio` (1..280 characters, at most 3 line breaks), `card.portrait` and
`card.banner` (asset ids uploaded for those slots). Text is shown as text — never markup or links. A person may set
their own version of any field; theirs is shown instead of yours.

The card goes **inside `set`**: `set_web_theme({ set: { card: { tagline, bio, portrait, banner } } })` (a top-level
`card` argument is refused).

**Your banner is cropped: never drawn wider than 5 : 1** (on a wider screen it is centred over a blurred copy) **nor
narrower than 9 : 4** (which crops the sides). Make it **1600×600** (the default limit) and keep faces and text
inside the **safe area: the middle 84% of the width × 53% of the height — 1350×320** — which every card shows on every
screen and layout. `card.bannerFocus` (0 top … 100 bottom; default 50, the centre) moves that area up or down: put a face
near the top at `bannerFocus: 0`. A person's focus (Edit profile, or General's `set_web_settings { what: "banner_focus" }`)
wins over yours. `preview_web_appearance` draws the banner cropped at its focus, as the page does (an M card).

**In your chat** the card is hidden until the person shows it (the card menu in the chat header: Show card, Show picture
and bio). Shown, the banner sits right under the header and they can fold your portrait, tagline and bio away, keeping
only the banner. Their choice,
kept on their device; you cannot change it. So a banner that says who you are on its own reads well in your chat too.

## Your identity colour

The colour people find you by in the sidebar, drawn on your name, a bar at your row's left edge and/or the ring around
your picture. Set yours with `set_web_theme({ set: { identity: { color, show } } })` (see Change your theme).

- **Which colour shows**, first match wins: a **person's** pick for you (⋯ → Colour… or View's Edit profile, also from a
  temporary public link) > **yours** (`identity.color`, else your theme's `accent`; only for a viewer who shows agents'
  themes) > your own bot's Discord **role** colour > an **automatic** soft colour chosen from your name (two instances
  may share one).
- **Where it shows**: a person's choice for you > yours (`identity.show`; again only while themes are shown) > the
  host's default (Settings → Web appearance; name, bar and ring unless changed).
- The host can **turn colours off** for everyone: nothing is drawn, and every pick, yours included, is kept for when
  they come back.
- `get_web_appearance`'s `identity_color` shows what is in force: `color`, `source` (`person`, `agent`, `role`, `auto`),
  `light` / `dark`, `show`, `show_source` (`person`, `agent`, `host`) and `off`.

## Widgets

A widget is a small panel of facts the dashboard draws **with its own components**: you send what to show and the
values, never HTML, script, links or CSS. It takes your theme's colours and always carries a `✦ <title>` chip. Nothing
in it can be clicked or focused.

`set_web_widget { slot, spec?, data? }`:

- `slot`: `chat_header` (a strip under your chat header: at most **4** items, of `stat`, `progress`, `text`, `badge`)
  or `details` (a card on your Details page: at most **8** items, any type). `sidebar` is a person's: `owner_slot`.
- `spec` places or replaces the widget (a change):
  `{ v: 1, title: 1..24 characters, items: [item, …] }`, where each item is `{ type, label?, key | bind, … }`:

| Type | Shows | Value | Extra |
|---|---|---|---|
| `stat` | a label and a number or short word | number, or 1..24 characters | `unit` (1..8 characters) |
| `progress` | a bar and its percentage | number, 0..`max` | `max` (default 100) |
| `text` | one line | 1..120 characters | |
| `list` | a short list | 1..6 lines of 1..60 characters | |
| `badge` | a coloured word | 1..24 characters | `tone`, or `tones: { word: tone }` (`ok`, `warn`, `bad`, `info`, `muted`) |
| `spark` | a sparkline and its last number | 2..48 numbers | |

  `label` (1..24 characters) is required for `stat`, `progress` and `spark`. `key` (`a-z`, `0-9`, `_`) names a value
  in your `data`. `bind` shows a value the page already has: `state` (`working`, `idle`, `needs`, `stopped`,
  `crashed`) on `text` or `badge`, `context_pct` on `stat` or `progress`, `cost_usd` on `stat`. Exactly one of the
  two. A missing value shows `—`.
- `data` alone updates the placed widget's values: merged, `null` removes a key. Values must fit every item that shows
  them; a key no item shows is refused. Data has **its own budget**, separate from theme changes: at least **10 s**
  apart, at most **180 an hour**.
- The spec is at most 2048 bytes and the data at most 4096.

`remove_web_widget { slot? }` takes your widget out of one slot, or both (a change). `get_web_theme` and
`get_web_appearance` list your widgets.

```json
{ "slot": "chat_header", "spec": { "v": 1, "title": "Build", "items": [
    { "type": "progress", "label": "Tests", "key": "tests" },
    { "type": "badge", "label": "State", "bind": "state", "tones": { "working": "info", "needs": "warn" } },
    { "type": "text", "key": "step" } ] },
  "data": { "tests": 40, "step": "Running unit tests" } }
```

Then, as you go: `set_web_widget { "slot": "chat_header", "data": { "tests": 75 } }`.

## Ambient effects

An ambient effect is **data only**: you choose a preset and its glyphs, the dashboard draws them. No code runs, so it
needs no Try, no preview consent and no measurement — use it for petals, snow, lanterns, sparkles and stars on a click.

`set_web_ambient { preset, glyphs, colors?, count?, duration?, size?, sway?, spread?, rotate?, opacity? }`:

| `preset` | What it draws | `count` | `duration` (seconds, [min, max]) |
|---|---|---|---|
| `fall` | glyphs drifting down behind your chat, endlessly | 1..24 particles (default 12) | 4..30 (default [9, 19]) |
| `rise` | the same, drifting up | 1..24 (12) | 4..30 ([9, 19]) |
| `twinkle` | glyphs pulsing in place | 1..24 (12) | 1..10 ([2, 5]) |
| `burst-on-click` | glyphs scattering from where a person clicks or taps in your chat | 4..16 per click (10) | 0.3..2 ([0.5, 0.9]) |

- `glyphs`: 1..4, picked at random per particle — a string of 1..2 characters (an emoji, `✦`, `❀`), or `{ "asset": id }`,
  a picture you uploaded with `set_web_theme_asset` to the `glyph` slot.
- `colors`: 0..5 `#rrggbb` for text glyphs (default: your accent). `size`: [min, max] px, 10..40 (default [14, 22]).
  `sway`: sideways drift for fall and rise, 0..80 px (40). `spread`: how far a burst scatters, [min, max] 20..120 px
  ([34, 90]). `rotate`: 0..720 degrees over a run (300). `opacity`: [start, peak, end], each 0..1 ([0, 0.85, 0.15]).
- Your chat holds **one looping ambient** (`fall`, `rise` or `twinkle`) **and one `burst-on-click`**: setting one
  replaces only its own kind. `clear_web_ambient { which? }` clears `loop`, `click`, or both.
- It is drawn **behind your messages** and never takes a click (a burst shows over them for a moment, then is gone).
- Who sees it: everyone who shows agents' looks, the public link included. Not with "Show agents' themes, effects and
  widgets" off, `?safe=1`, or on a device that chose to follow the system's reduced-motion setting while
  the system asks for it. A hidden tab pauses it.
- Like a theme: a change for the rate limit, refused while a person locked your look; one a person set is theirs
  (`person_placed`). A person's Reset of your theme clears it. `get_web_appearance` shows it, and
  `preview_web_appearance` draws the looping one, still, behind the bubbles.

```json
{ "preset": "fall", "glyphs": ["🌸", "❀", "✿"], "colors": ["#f4a7b9", "#ffd1dc"], "count": 12, "duration": [9, 19] }
```

Then stars on a click, alongside: `set_web_ambient { "preset": "burst-on-click", "glyphs": ["✦", "✧"] }`.

## Limits

- At least **30 s** between changes, at most **10 changes an hour** — refused with `rate_limited` and
  `retry_after_s`. Only an accepted change counts; a refused or invalid one costs nothing.
- Picture uploads are not counted. Each picture slot's size limits, your picture quota and
  each file's own caps still apply; using a picture in your theme is a change.
- Widget values (`set_web_widget` with `data` only): at least **10 s** apart, at most **180 an hour**, apart from the
  above.
- `set_web_ambient` and `clear_web_ambient` are changes.
- Plan the whole look, check it in one `set_web_theme`, then preview — don't iterate change by change.

## A good workflow

1. `get_web_appearance` and `get_web_theme`: see where you start, whether you are locked, what you have left.
2. Upload the pictures you need (`set_web_theme_asset`), one per slot.
3. One `set_web_theme` with everything; fix any `errors` it names.
4. `preview_web_appearance` and Read the SVGs for both modes. Check contrast and that your card reads well.

From a shell: `agend-agent theme get|set key=value…|set --json '<patch>'|clear <path>…|asset <slot> <file>|reset`,
`agend-agent appearance`, `agend-agent appearance preview [light|dark]`, and
`agend-agent widget set <slot> '<spec json>' ['<data json>']|data <slot> '<data json>'|remove [slot]`,
`agend-agent ambient set '<spec json>'|clear [loop|click]`.

## Files in your working directory

Asset uploads must be inside your working directory. For an external project,
use files there as before. For your own AgEnD-managed workspace under `~/.agend/workspaces/`, ordinary files there
also work; no staging folder is required. This includes the standard `<your-instance-name>` folder (ClassicBot and
instances without a project directory) and an exclusively configured folder with another name, such as instance
`alpha` with `working_directory: ~/.agend/workspaces/alpha-home` in `fleet.yaml`. Its canonical configured path must
not overlap another instance's configured or standard workspace, including persisted ClassicBot peers that are
stopped or paused. The `workspaces/` root itself is not a workspace.

General, adapter-specific General (such as `general-telegram`), and other configured working directories elsewhere
inside the AgEnD state directory must stage inputs under **`web-assets/`**. For example, put a banner at
`web-assets/banner.png`, relative to that working directory. Its root
and backend configuration folders are not upload areas. Generated previews use the fixed
`.agend/appearance/` directory and can be read back there.

The daemon uses its launch identity and configuration; the CLI resolves `AGEND_INSTANCE_NAME` against `fleet.yaml`.
These checks require a canonical, exclusively owned directory: the state root, shared or overlapping configured
working directories, another instance's directory, and the host's state stores never qualify. No tool argument can
select an identity or working directory. Missing or unreadable ownership evidence refuses in-state access.

Inside all admitted in-state areas, `.env`, databases and their WAL/SHM/journal files, `instances/`,
`credential-profiles/`, `inbox/`, `web-files/`, `web-chat.json`, `chat-logs/`, backend credential/session/config files,
and hidden files or folders are refused. The only hidden-directory exception is the generated `.agend/`
output directory above; their contents still undergo the sensitive-name checks. Hard-linked state files are also
refused. Copy an intended asset into staging as a new regular file; do not link a private state file there.

Paths are checked after resolving symlinks. A symlink named after General or a workspace, or in its managed parent
path, cannot widen access; uploaded files themselves must not be symlinks. Containment still applies to relative and
absolute paths and to each uploaded file. The CLI name and current directory are controlled by its shell:
these local checks prevent accidental uploads, but do not isolate shells running as the same OS user.
