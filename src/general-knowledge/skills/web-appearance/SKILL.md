---
name: web-appearance
description: How you look on the AgEnD web dashboard — check it, change your own theme, identity card, identity colour and widgets, play Canvas Worker effects in your chat (and offer a Try), preview the result, share it as a mod
roles: [worker]
---

## What it is

People see you on the web dashboard: in the sidebar, at the top of your chat, on your Details page and in View. You
can shape how you look there — **only your own look, and only on the surfaces that are yours**:

| Surface | What you set | Tools |
|---|---|---|
| Your name and role line | display name, description | `set_display_name`, `set_description` |
| Your status stamp | persona emoji | `set_persona_emoji` (see the `persona-emoji` skill) |
| Your chat | theme: colours, accent, bubbles, font, background picture, working label | `set_web_theme`, `set_web_theme_asset` |
| Your face and ring | theme picture and accent | `set_web_theme`, `set_web_theme_asset` |
| Your identity card | portrait, banner, tagline, bio | `set_web_theme` (`card.*`), `set_web_theme_asset` |
| Your identity colour | the colour people find you by in the sidebar, and where it shows (name, bar, ring) | `set_web_theme` (`identity`) |
| Your chat header strip and Details page | widgets: small panels of facts the dashboard draws | `set_web_widget`, `remove_web_widget` |
| A file of your look | a mod: export yours, or propose one for a person | `export_web_mod`, `propose_web_mod` |
| Effects in your chat | Canvas Worker animations, and Try cards a local admin may start | `upload_web_effect`, `apply_web_effect`, `preview_web_effect`, … (see Effects) |

None of these tools takes a target: they always act on you. You can't change another instance, the dashboard's own
chrome, a person's sidebar widget, or a person's custom CSS.

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
  `limits` (changes and uploads left, each picture slot's size limits, your picture quota).

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
  - `show` is a list of `name`, `bar` and `ring` (`[]` for nowhere). Left out, the host's default applies (ring and bar).
  - A person's choice for you in the dashboard always wins, field by field, and their Reset brings yours back.
    `get_web_appearance` says which is in force.
- `bubble`: `{ radius: 0..24, border: "none" | "thin" | "accent" }`.
- `font`: `"inter"`, `"system"` or `"mono"`.
- `background`: `{ image: <asset id>, fit: "cover" | "contain", opacity: 0.05..1 }`.
- `avatar`: an asset id — your face (below a person's upload).
- `workingLabel`: 1..24 characters on one line, shown while you work instead of "is working…".
- `card`: `{ portrait?, banner?, tagline?, bio? }` — see below.

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

A picture holds one slot: upload it again for another slot only if it is a different picture. `get_web_theme`'s
`limits.asset_slots` has the limits in force and `limits.asset_quota` how many pictures you may keep. A picture your
theme stops naming is deleted.

## Your identity card

`card.tagline` (one line, 1..60 characters), `card.bio` (1..280 characters, at most 3 line breaks), `card.portrait` and
`card.banner` (asset ids uploaded for those slots). Text is shown as text — never markup or links. A person may set
their own version of any field; theirs is shown instead of yours.

The card goes **inside `set`**: `set_web_theme({ set: { card: { tagline, bio, portrait, banner } } })` (a top-level
`card` argument is refused).

## Your identity colour

The colour people find you by in the sidebar, drawn on your name, a bar at your row's left edge and/or the ring around
your picture. Set yours with `set_web_theme({ set: { identity: { color, show } } })` (see Change your theme).

- **Which colour shows**, first match wins: a **person's** pick for you (⋯ → Colour… or View's Edit profile, also from a
  temporary public link) > **yours** (`identity.color`, else your theme's `accent`; only for a viewer who shows agents'
  themes) > your own bot's Discord **role** colour > an **automatic** soft colour chosen from your name (two instances
  may share one).
- **Where it shows**: a person's choice for you > yours (`identity.show`; again only while themes are shown) > the
  host's default (Settings → Web appearance; ring and bar unless changed).
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

## Mods

A mod is one file, `<name>-<version>.agendmod.json`, that carries a look: a theme with its pictures, card text,
widgets and effects. People import mods in **Settings → Web appearance → Mods**. **You never import**: a person reviews
everything in a mod and ticks what to apply.

- `export_web_mod { name, version, title? }` writes **your own** look to `.agend/mods/<name>-<version>.agendmod.json`
  in your working directory and returns `{ path, bytes }`. It carries your theme with its pictures, the effects your
  theme places (with their params) when they are yours or shared with you, your own card text (not a person's card
  fields), and the widgets you placed. A person's private effect placed on you stays out (`effects_omitted` counts it).
  It never carries custom CSS or the sidebar widget, which are a person's. `name` is a-z, 0-9 and -, `version` is
  MAJOR.MINOR.PATCH.
- `propose_web_mod { file }` sends a mod file from your working directory (at most 8 MiB) for a person to review. It
  is checked whole and answers with its problems if it isn't valid. **A mod carrying custom CSS is refused**
  (`owner_css_not_from_agent`). A muted line in your chat says it was proposed. Nothing changes until a person
  installs it. One proposal at a time: a new one replaces yours. It counts as an upload.
- A widget a person placed from a mod is theirs: you may give it values (`set_web_widget` with `data`), but not replace
  or remove it (`person_placed`).

The file format: `{ "format": "agend-mod", "v": 1, "manifest": { name, version, title, description?, author?,
requires?: { agend: ">=X.Y.Z" }, contents: { theme?, identity?, widgets?: { chat_header?, details? }, effects? } },
"files": { "<path>": { "sha256", "b64" } } }`. Every file is listed with its sha256 and used by exactly one part, paths
are lowercase with no `..`, and a theme names its pictures by path. The easiest way to get one right is to set your look
with the tools above, then `export_web_mod`.

## Limits

- At least **30 s** between changes, at most **10 changes an hour**, at most **3 picture uploads an hour** — refused
  with `rate_limited` and `retry_after_s`. Only an accepted change counts; a refused or invalid one costs nothing.
- Widget values (`set_web_widget` with `data` only): at least **10 s** apart, at most **180 an hour**, apart from the
  above.
- Effects: `apply_web_effect` and `remove_web_effect` are changes; `upload_web_effect` and `propose_web_mod` are uploads.
  At most 10 effects and 8 MiB of your own, at most two placed in your chat.
- Plan the whole look, check it in one `set_web_theme`, then preview — don't iterate change by change.

## A good workflow

1. `get_web_appearance` and `get_web_theme`: see where you start, whether you are locked, what you have left.
2. Upload the pictures you need (`set_web_theme_asset`), one per slot.
3. One `set_web_theme` with everything; fix any `errors` it names.
4. `preview_web_appearance` and Read the SVGs for both modes. Check contrast and that your card reads well.

From a shell: `agend-agent theme get|set key=value…|set --json '<patch>'|clear <path>…|asset <slot> <file>|reset`,
`agend-agent appearance`, `agend-agent appearance preview [light|dark]`, and
`agend-agent widget set <slot> '<spec json>' ['<data json>']|data <slot> '<data json>'|remove [slot]`, and
`agend-agent mod export <name> <version> [title]|propose <file>`.

## Files in your working directory

Asset uploads, effect directories and mod proposals must be inside your working directory. This includes your own
AgEnD-managed workspace (`~/.agend/workspaces/<your-instance-name>`), used by ClassicBot and instances without a
project directory. `web-assets/` and `web-effects/` are convenient staging folders, not required names. Paths are
checked after resolving symlinks: for the supplied caller identity, another instance's workspace and all other AgEnD
state remain forbidden, including
`.env`, databases, `instances/`, `credential-profiles/` and `inbox/`. Symlinks cannot grant access outside your working
directory or into protected state; uploaded files themselves must not be symlinks. Generated appearance previews and
mod exports follow the same workspace boundary. The CLI takes its caller name from `AGEND_INSTANCE_NAME` and its
working directory from the shell; these local checks do not isolate shells running as the same OS user.

## Effects

A Canvas Worker effect is a small animation drawn by code that runs in an isolated Worker: no page, no DOM, no
network. You place effects **only in your own chat**; a person can place them in the regions an effect's manifest
allows. None of these tools takes a target.

**The package** (CW1): a directory in your working directory with `effect.json` and `worker.js`, optionally
`poster.png`, `cursor.png` and `assets/*.png|jpg|jpeg|webp|gif`. No HTML or CSS, at most 20 files and 16 assets. The
smallest valid `effect.json`:

```json
{ "v": 1, "kind": "effect", "runtime": "canvas-worker-v1", "worker": "worker.js", "name": "spark", "title": "Spark", "regions": ["chat"], "layer": "behind", "wants": [] }
```

- Optional fields: `description`, `poster` (`"poster.png"`), `box`, `cursor` (its `hotspot` inside the image) and
  `params`.
  - `name`: 1..32 characters, starting with a-z or 0-9, then a-z, 0-9 and -.
  - `title` (1..40) and `description` (up to 200): one line each, counted in characters as people see them.
  - `regions`: 1–5 of `chat`, `sidebar`, `header`, `page`, `box`. **Include `chat` to play in your chat**: an effect
    without it can be placed but never plays there. The other regions are ones a person may choose it for.
  - `layer`: `behind` (under the content) or `front` (over it).
  - `wants`: up to 5 of `pointer`, `state`, `reply`, `mention`, `theme`. **`mention` is reserved and never fires in
    2.3.0** (see Effect event availability).
  - `params`: up to 16 typed parameters (`number`, `int`, `bool`, `enum`, `color`) a placement may set.
- `worker.js` (at most 1 MiB, a classic script: static `import` / `export` are refused) draws through the `agend` API:
  `canvas`, `params`, `asset()`, `on()`, `frame()` and `ready()`. Call `ready()` within 10 s, or it is stopped. Network
  and dynamic imports are blocked at run time; the upload may warn `network_or_import_api_unsupported`, but don't rely
  on the warning to catch every use.
- Size: `effect.json` at most 64 KiB; the whole effect at most 8 MiB as uploaded and **1 MiB normalized**. Pictures:
  at most 4096 px a side, and **8,388,608 pixels in total** across the assets, poster and cursor together. A cursor is
  a square PNG of at most 64 px and 32 KiB (after metadata is stripped).

**The tools:**

- `upload_web_effect { dir }` → `{ id, warnings }`. It counts as an upload (3 an hour, shared with pictures and mods).
  **Your own** copies are at most **10 effects and 8 MiB**; effects a person shared with you don't count.
- `list_web_effects` — your own effects and those a person shared with you: `id`, `name`, `title`, `regions`, `layer`,
  `bytes`, `latest_profile`.
- `apply_web_effect { id, params? }` places one in your chat, **at most two at a time**, with the declared `params`
  (unknown or out of range → `effect_params`). `remove_web_effect { id? }` takes one out, or all of them. Both are
  changes (30 s apart, 10 an hour), and are refused while a person has locked your theme (`locked`) or when the fleet
  turned agent changes off (`theme_editing_off`).
- `delete_web_effect { id }` deletes your own copy once nothing uses it; a placement, mod, stage or Try offer gives
  `effect_in_use`. Another's copy is never removed.
- `profile_web_effect { id }` — how it ran on viewers' pages, per device class: `unmeasured`, or `reported` with
  records carrying a `verdict` (`ok`, `degraded`, `paused`, `off`) and a `reason` (`host_budget`, `hidden`,
  `reduced_motion`, `save_data`, `viewer_off`, `clock_unavailable`, `gates_unknown`, or none).
  `list_web_effects`' `latest_profile` has the latest one. These are best-effort reports of what happened, not live
  notices. No measurement means unknown, never healthy.
- `preview_web_effect { id }` offers a Try card in your chat (see Try below).
- **Sharing is a person's act.** You can't share an effect. You may use one a person shared with you (list, apply,
  Try, profile, put in a mod) while it is shared. When they unshare it, a placement already in your chat stays
  eligible for playback (subject to the viewer's and the safety rules); applying, Try, listing, profiling or exporting
  it again needs your own copy or another share, else `not_found`. A placement is never a grant to export it.

**On a viewer's page:**

- At most **3** effects play at once, at most **2** of them `front` (1 and 1 on a constrained device); the rest wait
  (`frame_limit`, `front_limit`).
- Nothing plays in safe mode, over a temporary public link, with reduced motion or save-data, on a hidden page, while
  the viewer has effects off, or before they consent to previews. A `poster.png` may then show behind the chat (see
  Static Chat fallback). A visible menu or dialog stops `front` effects; these stops lift by themselves.
- **Safety pause** — it measures the page's responsiveness, not your Worker's CPU. The page's frame-rate floor is
  90% of what it measured before the effect started, capped at 55 fps (50 on a constrained device), so a 30 Hz screen
  has a 27 fps floor. Where the browser reports them, long tasks may take at most 50 ms a second (25 ms constrained);
  unknown timing doesn't count as free. Overlapping 2-second windows are judged at most once a second after a warm-up,
  and three bad judgements in a row pause the effect (`host_budget`).
- Only a viewer's explicit **Resume** restarts a safety-paused effect, and it doesn't clear the history: three such
  pauses within 24 hours turn the effect **off** for that viewer's browser and device class, across tabs and reloads,
  and Resume then refuses. It doesn't come back by itself after 24 hours.
- **Your `front` effects are paused while the viewer's custom CSS is on, loading or unknown**; `behind` effects play
  once the page's stock layout is proven. A person's placement is exempt. Don't keep re-applying (see below).

## Owner-level effect selections

The five owner keys `fx.sidebar`, `fx.header`, `fx.page`, `fx.box` and `fx.cursor` are a signed-in person's web
preferences, never agent tool targets. Platform-bound sessions use separate adapter/user buckets (no account merge).
A web-only `agend web --code` session uses the explicit **host-wide operator** bucket, shared by everyone signed in
as that host operator. Header tokens cannot read or write these five keys. Existing visible host preferences are
unchanged; there is no local-key migration. Profile/custom-CSS internal pointers keep their existing identity rules.

When a shared effect is unshared, a personal selection remains stored but becomes unavailable at its next resource
authorization. It supplies no further code or cursor image; the person can clear it. Its reference keeps the blob
from being collected until cleared. This is deliberately stricter than chat placements' retained-runtime reads:
a personal choice keeps following its person's current own/shared access, while a chat preserves the exact effect
placed there. A reference is not a sharing or export grant. Do not keep retrying a denied personal selection.

Owner selectors are available in Settings → Web appearance. With effects and preview consent enabled, personal
page/header/sidebar/box choices play across supported stock pages in the same pool as local signed-in Chat.
Web appearance offers slot Pause/Resume and unavailable/Clear controls. The personal cursor uses a static PNG on the host shell after the same consent: no Worker/code read or frame slot. It preserves explicit pointer/text/resize cursors, falls back while dragging or on failure, and has status/Clear rather than Worker Pause/Resume. Before revealing paint, the host must prove stock content
ordering and trust paint coverage. Agent front effects must remain paused when custom CSS is active, loading or
unknown; a person sees the reason and can open the causing setting. Human placements retain their exemption from
that agent restriction, and behind effects still require proven ordering. Saving a placement alone is not proof of
playback.

Visible menus, dialogs, Keep/tour notices and focused inputs suppress all foreground effects; a human placement
does not bypass those host safety gates. Unknown stock layout refuses admission. A trusted foreground plane is
deferred to #1940; do not keep reapplying an agent front while custom CSS is on, loading or unknown.

### Try: offer first, local admin click to start

`preview_web_effect({id})` posts a volatile Try card in your own web chat, using your current own/shared read rights. It starts nothing and changes no appearance. The sample is physically clipped inside its own host panel or sheet. Only an explicit
click by a signed-in **local admin** may start it; never an agent, public link, header token or automatic action.
The host owns a visible Trial label and Stop control. Closing the panel/sheet, navigating, window blur, or another
menu/dialog stops it. Custom CSS must be off (on/loading/unknown denies), and the same caps, profiler and safety
stops apply. Ordinary foreground effects stay suppressed. A volatile offer lasts at most ten minutes (offering the same effect again keeps that offer and its expiry; a different effect replaces it); every read
rechecks the originating agent's current own/shared access, with the trial bound to the admin's session and epoch.
There is no saved placement, claim, share, export or new saved profile record. Cards are memory-only and become inert when expired; a restart never restores them. Try uses manifest defaults and the existing app pool, not a second runtime. Do not treat an offer id or ordinary reply button
as permission to run or fetch an effect, and do not keep retrying an unavailable Try.


## Static Chat fallback

When preview is unavailable, consent is missing, motion/data settings prevent playback, or the page is a public link,
a current chat placement with a poster can show its static PNG **behind** the content; a front declaration does not
make its poster foreground. No poster means nothing is drawn. Safe mode and the viewer's show switch hide posters
too; unknown stock ordering refuses paint. Explicit Pause, queued effects and a failed live read are not replaced by
this surface fallback. A failed static read/decode stops its poster pool until a changed revision or page reload;
there is no automatic network retry. The public link offers no Effects playback controls or Worker code.

The public-link show switch is this browser's choice, kept separately from boot-cached host defaults; it never writes
a host preference. The ordinary signed-in switch keeps its existing host preference. Do not depend on decoration to
carry an important message.

## Effect event availability

Canvas Worker manifests may reserve `wants: ["mention"]`, but **mention is reserved and never emitted in 2.3.0**.
Do not build an effect that depends on it, infer mentions from reply text, or retry to obtain that signal. Provider-confirmed,
viewer-scoped direct-ID mention pulses are deferred to [#1963](https://github.com/songsid/AgEnD/issues/1963).
Reply pulses are transient: only a newly accepted live SSE agent reply can qualify. History, reconnect replay and polling
never create a pulse; a live receipt delayed over five seconds is dropped. No reply text, author or mention targets reach effects.
