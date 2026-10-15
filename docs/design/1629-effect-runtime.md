# Effects runtime implementation boundaries

The approved design is [#1629 r2](https://github.com/songsid/AgEnD/issues/1629#issuecomment-6127484841),
amended by [r3](https://github.com/songsid/AgEnD/issues/1629#issuecomment-6128007808)
and the widget/event deltas in r4 and r4.1. The [runtime delta](https://github.com/songsid/AgEnD/issues/1629#issuecomment-6197309471)
keeps ready-only inbound messages and renders inside one document. This document
records implementation scope, not permission to widen those boundaries.

## First slice: the local effect shim

`web-preview.ts` serves exact `GET /effect` on the existing separate preview listener.
The Host guard runs first. Its response uses the same CSP, Permissions Policy,
no-referrer, no-store, nosniff and CORP headers as `/frame`. Neither route reads cookies.
`/frame` keeps its existing protocol and public-preview behavior. Public-link origins
may widen `/frame` only; they are not added to `/effect`'s accepted parents or CSP.
The public-preview gateway does not serve `/effect`.

The effect shim announces `{v:1,type:"ready",ch:null,boot}` to its parent. It accepts
one exact `{v:1,type:"render",ch,html}` from an explicitly listed, non-opaque parent
origin and the actual parent window, with one transferred port and at most 1 MiB of
UTF-8 HTML. Invalid messages leave it waiting. The document installs a frozen,
non-replaceable `agend.on(kind, fn)` / `agend.ready()` API before executing that HTML.
It parses the HTML, adopts head/body and rebuilds supported scripts in document order;
it never calls `document.open/write/close`. Ordinary render has only one iframe load,
so the parent's second-load navigation fence needs no exception.

The port stays in a closure. `ready()` can send only one `{type:"ready"}`; there is no
command, heartbeat, resize, ping or pong API. A render failure closes the port and
does not permit another render.

Effect scripts and subscription callbacks run in separate tasks, outside the
port-bearing event dispatch. The shim captures its native scheduler and MessageEvent
data getter before effect code executes. This avoids exposing the port through
legacy `window.event` or a poisoned data getter; the browser controls cover those
specific routes. The parent must still treat the effect as hostile and enforce its
ready-only protocol independently of the facade.

### Supported template

- HTML fragments or documents, inline styles, visual HTML/canvas and inline classic
  JavaScript. Images/fonts are data URLs after bundle inlining.
- Scripts execute in document order after DOM preparation: even a head script sees
  the completed body. Only absent/empty, `text/javascript` or `application/javascript`
  types are accepted. JavaScript assets are not part of the bundle asset format.
- Modules, external scripts and script attributes other than `type` are refused.
  Native async/defer timing is not reproduced; those attributes are refused rather
  than silently ignored. Ordered execution after DOM preparation is the approximation.
- Base/link/nested frame/object/embed/portal/template elements and `meta http-equiv`
  are refused. The reusable upload validator uses `parse5`'s HTML5 parser in
  scripting-disabled mode to match native `DOMParser(text/html)`, including
  markup inside `noscript`. The shim validates the native parsed document too,
  including script namespaces and attributes. Both reject element nesting deeper
  than 256 (including html/head/body), using iterative traversal rather than recursion.
- `document.open/write/writeln/close` are unsupported. Recognizable uses are refused,
  and the shim guards its document methods. This is a compatibility check, not static
  proof about arbitrary JavaScript. Sandbox/CSP and navigation removal still apply to
  obfuscated or dynamically constructed code.
- Synthetic DOMContentLoaded/load events run author convenience callbacks once.
  They are not security or health evidence. Native bootstrap lifecycle events are
  suppressed from effect listeners without suppressing the parent's iframe load.

A supported starting `effect.html` (the manifest and asset inliner are a later slice):

```html
<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; overflow: hidden; background: transparent; }
</style></head><body><canvas id="fx"></canvas><script>
  const canvas = document.getElementById("fx");
  agend.on("env", ({ width, height }) => {
    canvas.width = width;
    canvas.height = height;
  });
  agend.ready();
</script></body></html>
```

This slice does not create dashboard frames, expand the dashboard's `frame-src`,
read bundles, expose tools, or enable placements. Subsequent slices must supply
the exact-window/boot handshake on the parent, closed event validation before send,
registry caps, host-owned geometry, trust-area clipping and the profiler before
effects can be mounted. The parent's inbound port policy must accept only one
exact `ready` and drop all other messages without state changes, logs or counters.

## Evidence limits

The focused shim tests execute the generated script in an inert VM. Scratch HTTP
tests exercise the real local listener and public gateway with process creation
denied. They verify routing and response headers, not native browser enforcement
or process isolation. A separate scratch Chromium 156 control verifies one normal
load, ordered classic scripts, one synthetic lifecycle, opaque DOM/cookie/storage
denial, CSP-blocked fetch, one port ready and event reception. Its diagnostic parent
removes frames on real location/meta navigation (second load); form submission is
prevented by the unchanged sandbox, so no navigation occurs. It is not the product
registry, which must repeat these controls before mounting.

As with the existing preview design, sandbox/CSP do not guarantee zero outbound
bytes: self-navigation and browser-specific residual behavior remain limitations.
No effect receives message content, authentication material or dashboard commands.
