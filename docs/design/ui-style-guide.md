# AgEnD web UI style guide

[繁體中文](ui-style-guide.zh-TW.md)

This guide is for anyone who changes the web dashboard or the Hub pages, including external contributors. Every rule
here is already settled: it comes from a merged PR, a test or a recorded decision, and each one says where it came from.
Reviewers check UI pull requests against it.

Before writing new markup or CSS, find the closest existing screen and copy what it does. A UI change should look as
if it had always been part of the product.

## How a rule is checked

Each rule says how it is checked:

- **CI** — a test or the UI gate fails the pull request.
- **Review** — no automated check; the reviewer looks for it in the diff and the screenshots.

The table at the end lists both.

## 1. Use the shared components

Use the existing shared components and classes. Don't add a one-off style for something that already exists
(decision 3536dae9). The PR body names the shared component or the existing section the change follows.

| Need | Use | File |
|---|---|---|
| Page title, scope and lead | `PageHead` | `src/ui/shared/page-head.js` (2.3.5 line) |
| A box of content | `.card` | `src/ui/shared/app.css` |
| A Settings group and its rows | `.s-group`, `.s-group-head`, `.s-row`, `.field`, `.grid2` | `app.css` |
| Buttons | `.btn`, `.btn-primary`, `.btn-danger`, `.btn-ghost`, `.btn-sm`, `.icon-btn` | `app.css` |
| A small status label | `.tag`, `.tag.ok`, `.tag.warn` | `app.css` |
| Hint text / an error line | `.note` / `.err` | `app.css` |
| Loading, empty, failed | `Skeleton`, `Empty`, `ErrorState` | `src/ui/shared/ui-states.js` |
| A dialog / a confirmation | `Dialog` / `confirmDialog` | `ui-dialog.js` / `ui-confirm.js` |
| A short result message | `toast(text, ok)` | `ui-toast.js` |
| Icons | `Icon({ name, size })` | `ui-icons.js` |

Do:

```js
html`<section class="card s-group"><div class="s-group-head"><h3>${t("x.title")}</h3></div>…</section>`
```

Don't:

```js
html`<section class="s-card">…</section>`   // no such style: it rendered unframed (#3320)
```

Checked by: **Review**.

## 2. One card frame on every Settings page

Every top-level Settings card has the same frame: a 1px `--border` border, `--r-md` corners, and the same padding. A
card inside a drawer or a disclosure is part of that box and has no frame of its own. Nothing inside a card is wider
than the card: bound a `select` or input with `max-width: 100%` (#3320).

Checked by: **CI** — the UI gate's `:frame` check compares padding, border and corner radius of every top-level card.

## 3. A coloured left edge is the straight bar

A coloured left edge (state, selection, a quote) is the straight 3px bar: add `.lbar` and set `--lbar-color`. Never put
a `border-left` accent on a box with rounded corners: the border curves into the corners (#2330, #2332, #2478/#2489).

Do:

```css
.my-row { --lbar-color: var(--ok); }          /* with class="… lbar" in the markup */
```

Don't:

```css
.my-row { border-left: 4px solid var(--ok); }  /* .s-row has border-radius: var(--r-md) */
```

Checked by: **CI** — `tests/web-left-bar-2330.test.ts`. The test compares the last compound selector of each rule, so a
rounded class from another rule on the same element (for example `.s-row` plus a new row class) can slip through. Reviewers
check that case by eye.

## 4. Tokens for spacing, type, radius and colour, in light and dark

Take sizes and colours from `src/ui/shared/tokens.css`:

- spacing `--s-1` … `--s-8` (a 4px grid);
- type `--fs-xs` … `--fs-xl` with their `--lh-*`, weights `--fw-*`;
- corners `--r-sm`, `--r-md`, `--r-lg`, `--r-full`;
- colours by meaning: `--text`, `--text-2`, `--text-3`, `--surface`, `--surface-2`, `--border`, `--accent`, `--ok`,
  `--warn`, `--danger` and their `-bg` / `-line` variants.

Dark is the default `:root`; light overrides the same names. A colour written as a token therefore works in both
themes; a hex value doesn't.

Do: `color: var(--text-3); padding: var(--s-3) var(--s-4);`

Don't: `color: #888; padding: 13px;`

Checked by: **CI** for the tokens themselves (`tests/web-tokens-1408.test.ts`: light and dark define the same names, text
meets 4.5:1 and focus/borders 3:1). **Review** for their use: nothing scans the stylesheets for literal colours or pixel
sizes, and some older rules still have them.

## 5. No inline styles

The pages run under a Content-Security-Policy with `style-src 'self'`. Don't write a `style=` attribute, `el({ style })`,
`setAttribute("style", …)`, a `<style>` element or a constructed stylesheet. Use a class; set a run-time size through
the CSSOM (`el.style.setProperty(...)`) (#1300).

Do: `` html`<button class="btn btn-primary">` ``

Don't: `` html`<div style=${"width:" + w + "px"}>` ``

Checked by: **CI** — `tests/web-csp-1300.test.ts`.

## 6. Loading, empty and failed states

- A first read shows `Skeleton` in the shape of what will appear. A refresh keeps the content already shown (#3294,
  #3295).
- Nothing to show is `Empty` with a hint of what to do next.
- A failed read is `ErrorState` with Retry, not an empty list.

Do: `` !data ? html`<${Skeleton} variant="rows" lines=${4} />` : … ``

Don't: a bare "Loading…" text, or a spinner that replaces content on every refresh.

Checked by: **CI** — `tests/skeleton-loading-3290.test.ts` for the shared states. **Review** for new pages.

## 7. Phone and desktop, no horizontal scroll

Every page works at a 390 px phone and a 1366 px desktop, in between (900–1366 px), and with long values (a long name,
a long option). Nothing scrolls sideways. The layout switches to phone at 899 px (`max-width: 899px`). On a phone or a
touch screen, inputs are at least 16px so iOS doesn't zoom, and controls aim for the `--tap` size (44px).

Checked by: **CI** — the UI gate's `:overflow` check (with every disclosure opened and a long option added) on Settings,
and `tests/web-input-zoom-1611.test.ts`. **Review** for pages outside Settings, using the screenshots.

## 8. Every string in English and Traditional Chinese

Every visible string goes through the string tables (`register()` / `t()` in `src/ui/shared/app-i18n.js`, or the
page's own strings module) with both `en` and `zh-TW`. No English text written into a template, a toast or a
confirmation.

Do: `` html`<p class="note">${t("x.hint")}</p>` ``

Don't: `` html`<p class="note">Saved!</p>` ``

Checked by: **CI** — `tests/i18n-ui-literals-2390.test.ts` (literal English in templates, and en/zh-TW key parity).
**Review** for the zh-TW wording, which should read as natural Chinese.

## 9. Finish where you started, with as few clicks as possible

From decision 721ca0c3:

- **Same surface.** A flow offered in the web finishes in the web. Sending the person to Telegram, Discord or a
  terminal to finish is a bug, unless a security rule needs a second factor; then the page offers it in place (for
  example web TOTP confirmation) and explains any fallback in place.
- **No host commands.** The UI never tells the person to type a command on the host. When a confirmation can't happen
  in the page, point to General in Telegram or Discord.
- **Minimal clicks.** Don't add a confirmation dialog, an extra approval or a "press this to continue" step unless a
  recorded threat (decision 64a289a0) needs it, and then reuse a click the person already makes. The PR body says why
  any new click or confirmation is needed.

Checked by: **Review**. The PR body states which surfaces the flow supports.

## 10. Errors in plain words

An error says what happened and what the person can do, in their words: "The Hub can't be reached." with Retry, not
`ECONNREFUSED` or a status code. Keep server codes for logs.

Checked by: **Review**.

## Evidence in the pull request

A PR that adds or changes UI includes (decision 3536dae9):

- screenshots before and after: desktop and phone, light and dark, English and Traditional Chinese;
- the shared component or existing section it follows;
- for a new flow, the surfaces it supports and why any added click or confirmation is needed.

## What CI checks and what review checks

| Rule | CI | Review |
|---|---|---|
| 1. Shared components | — | yes |
| 2. One card frame (Settings) | UI gate `:frame` | other pages |
| 3. Straight left bar | `web-left-bar-2330` | a rounded class from another rule on the same element |
| 4. Tokens, light and dark | `web-tokens-1408` (token set, contrast) | literal colours and sizes in new CSS |
| 5. No inline styles | `web-csp-1300` | — |
| 6. Loading / empty / failed | `skeleton-loading-3290` | new pages |
| 7. Phone and desktop | UI gate `:overflow` (Settings), `web-input-zoom-1611` | pages outside Settings |
| 8. EN and zh-TW | `i18n-ui-literals-2390` | wording |
| 9. Same surface, minimal clicks | — | yes |
| 10. Plain-words errors | — | yes |
| Button sizes (Settings) | UI gate `:buttons` (one height per button class combination) | — |
| No page errors or CSP reports (Settings) | UI gate `:no-errors` | — |

The UI gate is `scripts/manual/smoke/smoke-settings-ui-gate.mts`, run by the `ui-gate` job in
`.github/workflows/ci.yml` on every Settings section at `desk-light-en` and `phone-dark-zh-TW`, plus a 1024 px desktop
width.
