---
name: web-appearance
description: How you look on the AgEnD web dashboard — check it, change your own theme and identity card, preview the result
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

None of these tools takes a target: they always act on you. You can't change another instance, the dashboard's own
chrome, or a person's custom CSS.

## Look first

- `get_web_appearance` — how you appear **now**, resolved exactly as the dashboard resolves it: your face and where it
  comes from (`profile`, `theme`, `bot`, `emoji` or `initial`), your ring colour, your card field by field (each marked
  `human` or `agent`), your theme per light/dark mode after the defaults, whether a person locked it, and your limits.
- `preview_web_appearance` (`modes`: `["light"]`, `["dark"]` or both) — draws that as an SVG per mode into
  `.agend/appearance/<mode>.svg` in your working directory and returns the paths. Read them: you get exact colours,
  geometry and text. Only your own pictures are inside.
- `get_web_theme` — your stored theme, the token defaults it is drawn over, your uploaded pictures (`id`, `slot`), and
  `limits` (changes and uploads left, each picture slot's size limits, your picture quota).

## What wins over what

- **A person's choices win.** A picture uploaded for you in View beats your theme picture. A person's card field (from
  View's Edit profile) beats yours, field by field — leave it to them. A person can **Lock** your theme (every change
  you try is refused with `locked`) or **Reset** it (your theme, card and pictures go; a lock stays).
- **Each viewer decides what they see.** Anyone can turn agents' themes off for their own screens, and `?safe=1` loads a
  page without them; they then see the default look and your bot's face. Don't rely on your theme to say something
  important.
- The fleet can turn agent changes off entirely (`web.themes.agent_edit: false`): every change is refused with
  `theme_editing_off`; what you stored stays.

## Change your theme

`set_web_theme { set?, clear? }` — all or nothing; `set` merges into your current theme, `clear` removes dotted paths.
Typed values only; anything else is refused with `{ errors: [{ path, problem }] }`:

- `colors.light` / `colors.dark`: any of `bg`, `surface`, `text`, `text2`, `accent`, `userBubble`, `agentBubble` as
  `#rrggbb` (or `#rgb`). **Contrast is checked per mode**: `text` at least 4.5:1 on `bg`, `surface` and both bubbles;
  `text2` at least 4.5:1 on `bg` and `surface`; `accent` at least 3:1 on `bg` — a palette that fails is refused, naming
  the pair.
- `accent`: `#rrggbb` for both modes (a mode's own `accent` wins).
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

## Limits

- At least **30 s** between changes, at most **10 changes an hour**, at most **3 picture uploads an hour** — refused
  with `rate_limited` and `retry_after_s`. Only an accepted change counts; a refused or invalid one costs nothing.
- Plan the whole look, check it in one `set_web_theme`, then preview — don't iterate change by change.

## A good workflow

1. `get_web_appearance` and `get_web_theme`: see where you start, whether you are locked, what you have left.
2. Upload the pictures you need (`set_web_theme_asset`), one per slot.
3. One `set_web_theme` with everything; fix any `errors` it names.
4. `preview_web_appearance` and Read the SVGs for both modes. Check contrast and that your card reads well.

From a shell: `agend-agent theme get|set key=value…|set --json '<patch>'|clear <path>…|asset <slot> <file>|reset`,
`agend-agent appearance` and `agend-agent appearance preview [light|dark]`.
