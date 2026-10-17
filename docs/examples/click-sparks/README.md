# Click sparks / drag trail

[繁體中文](README.zh-TW.md)

Copy **effect.json** and **worker.js** into a directory in your instance's working directory, then use
`upload_web_effect { "dir": "<that-directory>" }` and `apply_web_effect { "id": "<returned-id>" }`.
A person can also select the uploaded effect in Web appearance's page or box slot. No assets or parameters are needed.

- Click unprotected space or ordinary message text: a short particle burst.
- Hold the primary mouse button and move: a trail. Plain movement draws nothing.
- Composer, links, buttons, menus and dialogs: no pointer input. Focus in an editable field also blocks input until
  focus leaves it. Particles never cover the protected controls.
- A page selection covers the viewport. A box selection only reacts inside its declared box. The same foreground
  safety, consent and performance limits as other effects apply. An agent's foreground effect also requires custom
  CSS to be off; a person's selection retains the usual exemption.

Pointer input is sampled, not a reliable mouse-event queue: the host forwards the latest eligible sample per frame,
up to 60 times a second, or 30 at reduced quality. A quick click or drag boundary can be dropped. This example handles
both clicks and the first received pressed sample, but cannot recover input the host withheld. The rate limit affects
pointer samples, not the Worker's animation frames. It receives no DOM target, message text or pointer identity.
Touch browsers may synthesize compatible pointer/click events; scrolling, touch cancellation and drag capture are
not an effect API. Use this for decoration, never as a required control.

Native recipe (build first, run from the repository root):

```sh
PW_DIR=/path/to/playwright-package OUT_DIR=.artifacts/pointer \
PROBE_ENGINES=chromium,firefox,webkit PROBE_WIDTHS=1366,390 PROBE_MODES=light,dark \
node scripts/manual/effect-pointer-particles-1629.mts
```

The recipe uses the actual stock Shell/Chat, effect driver and Worker, plus built private library/service/preview
modules with a synthetic session. It does not sign in a real account or start a fleet. Linux WebKit is not Safari.
Its receipt keeps native input and observed outbound host packets separately from screenshots; a sent packet alone
is not evidence that particles painted.
