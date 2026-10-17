# Click sparks / drag trail

[繁體中文](click-sparks.zh-TW.md)

Copy [effect.json](click-sparks/effect.json) and [worker.js](click-sparks/worker.js) into a directory in your instance's working directory, then use
`upload_web_effect { "dir": "<that-directory>" }` and `apply_web_effect { "id": "<returned-id>" }`.
A person can also select the uploaded effect in Web appearance's page or box slot. No assets or parameters are needed. The bitmap is at most 512 px per side; painting is capped at 30 fps and stops when the particles are gone. Pointer sampling has its own separate limit below.

If the chat opens with focus in the composer, click an empty area and wait for playback to start before testing another click. Input is forwarded only to an already ready effect.

- Click unprotected space or ordinary message text: a short particle burst.
- Hold the primary mouse button and move: a trail. Plain movement draws nothing.
- Composer, links, buttons, menus and dialogs: no pointer input. Focus in an editable field also blocks input until
  focus leaves it. Particles never cover the protected controls.
- A page selection covers the viewport. A box selection only reacts inside its declared box. The same foreground
  safety, consent and performance limits as other effects apply. An agent's foreground effect also requires custom
  CSS to be off; a person's selection retains the usual exemption.

Pointer input is sampled, not a reliable mouse-event queue: the host keeps one eligible sample per frame,
up to 60 times a second, or 30 at reduced quality. New movement replaces movement, but cannot overwrite a waiting
click or other discrete sample. Near-simultaneous down/up/click coalesce to the final click. Intermediate click or drag boundaries can still be dropped. This example handles
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

### Capture notes

Use `PROBE_TMP_DIR` for a short owned temporary directory if Chromium's socket path is too long. Linux launches set
`FONTCONFIG_FILE=/etc/fonts/fonts.conf`. Each interaction group uses a fresh context; safety is active and history is
never cleared during a case. `PROBE_GROUPS` selects `clicks`, `protected`, `drag-slow`, `drag-fast`, `degraded` or `touch`;
`PROBE_SURFACES` selects `chat`, `page`, `box`. Firefox uses its native screenshot protocol through the in-process
Playwright handle; `PROBE_RAW_SCREENSHOT=0` selects public screenshot preparation for diagnosis. Durations, native
input, host packet timings and actual particle pixels are recorded separately; missing required input or paint exits nonzero.

Packet intervals include final frame validation and IPC delay; they show observed pacing, not the exact 60/30 Hz acceptance clock. The registry unit tests pin that gate. A few colored pixels below the smoke threshold are insufficient visual evidence, not proof of zero paint.
