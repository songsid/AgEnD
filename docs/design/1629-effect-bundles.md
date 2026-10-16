# Canvas Worker bundle format: CW1 (#1629)

This is the unshipped format agreed by B2 and the r4-5 bundle owner. It validates bytes and metadata only; it neither authorizes an upload/placement nor runs the code. Widgets have a separate host-rendered schema and are not effect entries.

## Files

```
effect.json     required closed manifest
worker.js       required single UTF-8 classic Worker entry
poster.png      optional static fallback
cursor.png      optional PNG cursor, paired with manifest.cursor
assets/name.png optional raster assets (PNG/JPEG/WebP/GIF), at most 16
```

Names are fixed except `assets/<safe-name>.<extension>`: lowercase alphanumeric, `_`/`-`, one subdirectory, no traversal, URL, HTML, CSS, module/helper file, SVG or WOFF2. Assets are transported as bytes and decoded by the trusted shim into ImageBitmaps, never HTML/data-URL markup. The bounded script is compiled as classic syntax by the host Node parser, never executed. Static module syntax and malformed scripts are rejected with a generic error. This is a syntax compatibility check, not a sandbox; newer browser syntax not yet supported by the host parser is refused. Code imports/network APIs are unsupported; a lint warning is not a security boundary. The Worker/CSP is the execution boundary. See [Node’s Script constructor](https://github.com/nodejs/node/blob/v22.x/doc/api/vm.md#new-vmscriptcode-options) for its compile-without-run contract.

Limits are checked before storage: raw entry ≤8MiB (the mod input bound), manifest ≤64KiB, script ≤1MiB, and **all normalized files together ≤1MiB**. Raster headers are bounded to 4096 px per side and 8,388,608 pixels in aggregate, before any browser decode. Cursor is PNG only, square≤64px and≤32KiB after normalization, with hotspot inside it. These are header/structure checks, not a native image decoder: corrupt compressed bodies may still be refused safely by browser startup.

The shared `web-image-meta.ts` helper strips PNG/JPEG/WebP metadata; its GIF normalization currently preserves bytes. There is no claim that GIF comments are stripped. Posters and cursors are PNG. The script bytes are preserved, and invalid UTF-8 is rejected without replacement characters. The manifest is canonicalized. An optional poster file supplies the canonical poster declaration if omitted; a declaration without its file is an error. Cursor declaration/file must agree.

## Manifest and params

```json
{
  "v":1,"runtime":"canvas-worker-v1","worker":"worker.js",
  "name":"particles","title":"Particles","regions":["chat"],"layer":"behind",
  "wants":["state","pointer"],
  "params":{"count":{"type":"int","min":0,"max":100,"default":20}}
}
```

`kind` is canonicalized to `effect`. Unknown keys are refused. r2 regions/layer/box/wants/cursor are declarations, never authority: an agent still cannot grant itself a page, owner cursor, target instance or fleet event. Text uses the shared NFC/visible-grapheme rule (emoji joiners allowed), with UTF-16 bounds too. Regions and wants cannot contain duplicates.

At most 16 parameter names matching `[a-z][a-z0-9_]{0,31}`:

- `number`: finite min/max/default within ±1e9, min≤max, optional positive finite step; default and overrides must lie on the step.
- `int`: the same range, integer min/max/default; integer overrides.
- `bool`: boolean default/overrides.
- `enum`:1–16 distinct slugs, default/override is one of them.
- `color`: six-digit hex default/override, normalized lowercase.

No arbitrary JSON Schema, `$ref`, executable strings, objects or URLs. `resolveEffectParams` rejects unknown/invalid overrides, supplies defaults and returns only nondefault overrides for persistence. Stored metadata is never a principal or provenance source.

## Identity and snapshots

`checkEffectEntry(Map<relativePath,Uint8Array>)` is pure and synchronous. It returns normalized independent file snapshots, manifest, total bytes, id/full SHA and bounded warning tags, or generic `{path,problem}` errors without code or parser excerpts. Input bytes are snapshotted before parsing/normalization.

The canonical representation is JSON of `{manifest,files}`, with the normalized manifest's object keys sorted and every normalized file (including effect.json) represented by `[path,sha256]`, sorted by path. The id is the first 32 hex of the full SHA256 of that JSON. Path order and manifest formatting do not affect it; changing retained bytes does. Prefix collisions must still compare full SHA before any library write.

## Scope and rollback

This module does no filesystem I/O, image decoding, JS execution, principal resolution, quota change or UI mounting. The subsequent library revalidates snapshots before claims and applies principal/quota/reference/transaction rules. Mod import uses effect paths until that library resolves them to ids; parameters are checked before any commit.

Rollback is reverting this feature-branch validator PR; no persisted production data exists yet. Other backends, fleet lifecycle, setup and service/update paths are unaffected.


## Reserved mention trigger

The `mention` codec/manifest kind remains reserved for compatibility, but the registry and independent final-send gate never emit it in 2.3.0. No text parsing or inferred target is permitted. Provider-confirmed direct-ID, viewer-scoped boolean pulses are deferred to [#1963](https://github.com/songsid/AgEnD/issues/1963). Worker subscriptions may name the reserved kind without receiving events.
