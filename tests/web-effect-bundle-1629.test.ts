import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { checkEffectEntry, WEB_EFFECT_MAX_BYTES, effectRasterAssets } from "../src/web-effect-bundle.js";
import { parseWebEffectManifest, resolveEffectParams } from "../src/web-effect.js";
const manifest = () => ({ v: 1, runtime: "canvas-worker-v1", worker: "worker.js", name: "fixture", title: "Fixture", regions: ["chat"], layer: "behind", wants: ["state"], params: { count: { type: "int", min: 0, max: 10, default: 2 }, enabled: { type: "bool", default: true }, tone: { type: "color", default: "#AABBCC" }, mode: { type: "enum", values: ["calm", "fast"], default: "calm" }, speed: { type: "number", min: 0, max: 1, step: 0.25, default: 0.5 } } });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4ZkAAAAASUVORK5CYII=", "base64");
function files(m: unknown = manifest()) { return new Map<string, Uint8Array>([["effect.json", Buffer.from(JSON.stringify(m))], ["worker.js", Buffer.from("agend.ready()")]]); }
function checked() {
  const parsed = parseWebEffectManifest(manifest());
  if (!parsed.ok)
    throw Error("invalid control");
  return parsed.manifest;
}
describe("#1629 CW1 pure entry validation", () => {
  it("normalizes a valid Worker entry and returns a stable content id", () => {
    const a = checkEffectEntry(files());
    expect(a.ok).toBe(true);
    if (!a.ok)
      return;
    expect(a.id).toMatch(/^[0-9a-f]{32}$/);
    expect(a.sha256.startsWith(a.id)).toBe(true);
    expect(a.manifest.runtime).toBe("canvas-worker-v1");
    expect(a.manifest.kind).toBe("effect");
    expect(a.files.has("effect.html")).toBe(false);
    expect(a.bytes).toBeLessThan(WEB_EFFECT_MAX_BYTES);
    const b = checkEffectEntry(new Map([...files()].reverse()));
    expect(b.ok && b.id).toBe(a.id);
    const changed = files();
    changed.set("worker.js", Buffer.from("agend.ready();"));
    const c = checkEffectEntry(changed);
    expect(c.ok && c.id).not.toBe(a.id);
  });
  it("hashes the exact canonical manifest and every normalized file", () => {
    const m = { v: 1, runtime: "canvas-worker-v1", worker: "worker.js", name: "fixture", title: "Fixture", regions: ["chat"], layer: "behind", wants: ["state"] };
    const a = checkEffectEntry(files(m));
    expect(a.ok).toBe(true);
    if (!a.ok)
      return;
    const normalized = { kind: "effect", layer: "behind", name: "fixture", regions: ["chat"], runtime: "canvas-worker-v1", title: "Fixture", v: 1, wants: ["state"], worker: "worker.js" };
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    const expected = sha(JSON.stringify({ manifest: normalized, files: [["effect.json", sha(JSON.stringify(normalized))], ["worker.js", sha("agend.ready()")]] }));
    expect(a.sha256).toBe(expected);
    expect(a.id).toBe(expected.slice(0, 32));
  });
  it("uses the shared NFC/visible-text rule, including emoji joiners", () => {
    const good = checkEffectEntry(files({ ...manifest(), title: "👨‍👩‍👧 é" }));
    expect(good.ok).toBe(true);
    for (const title of [" ", "\u200d", "bad\u202e", " bad", "a".repeat(401)])
      expect(checkEffectEntry(files({ ...manifest(), title })).ok).toBe(false);
  });
  it.each(["effect.html", "style.css", "assets/a.svg", "assets/font.woff2", "../worker.js", "assets/../x.png", "worker2.js"])("refuses an unsupported path %s", path => { const f = files(); f.set(path, Buffer.from("x")); expect(checkEffectEntry(f).ok).toBe(false); });
  it.each([
    { runtime: "html" }, { worker: "other.js" }, { owner: "human" }, { target: "sibling" }, { wants: ["fleet"] }, { fps: 120 }, { params: { x: { type: "string", default: "https://bad" } } }, { params: { x: { type: "int", min: 0, max: 10, default: 1.5 } } }, { params: { x: { type: "enum", values: ["a"], default: "b" } } }, { params: { x: { type: "number", min: 0, max: 1, step: 0, default: 0 } } }, { params: { x: { type: "number", min: 0, max: 1, step: 0.3, default: 0.2 } } },
  ])("refuses an invalid/authority-bearing manifest %j", delta => { expect(checkEffectEntry(files({ ...manifest(), ...delta })).ok).toBe(false); });
  it("uses fatal UTF-8 for both manifest and script", () => {
    for (const path of ["effect.json", "worker.js"]) {
      const f = files();
      f.set(path, path === "worker.js" ? Buffer.concat([Buffer.from("//"), Buffer.from([0xc3, 0x28])]) : new Uint8Array([0xc3, 0x28]));
      expect(checkEffectEntry(f).ok).toBe(false);
    }
  });
  it.each(["const =", "import value from './helper.js';", "export default 1;", "<canvas></canvas>"])("refuses invalid classic script syntax %s", code => { const f = files(); f.set("worker.js", Buffer.from(code)); expect(checkEffectEntry(f)).toMatchObject({ ok: false, problems: [{ path: "worker.js", problem: "invalid_classic_script" }] }); });
  it("checks syntax without executing author code", () => { const f = files(); f.set("worker.js", Buffer.from("globalThis.__cw1_compile_probe__ = true; throw Error('private syntax probe');")); expect(checkEffectEntry(f).ok).toBe(true); expect(Object.hasOwn(globalThis, "__cw1_compile_probe__")).toBe(false); });
  it("refuses oversize normalized bytes", () => { const f = files(); f.set("worker.js", Buffer.alloc(WEB_EFFECT_MAX_BYTES)); expect(checkEffectEntry(f)).toMatchObject({ ok: false, problems: [{ problem: "entry_too_large" }] }); });
  it("strips metadata before identity, without changing image bytes or invoking a decoder", () => {
    const f = files();
    f.set("assets/one.png", png);
    const a = checkEffectEntry(f);
    expect(a.ok).toBe(true);
    if (!a.ok)
      return;
    const secret = Buffer.from("key\0private-location");
    const chunk = Buffer.alloc(secret.length + 12);
    chunk.writeUInt32BE(secret.length);
    chunk.write("tEXt", 4);
    secret.copy(chunk, 8);
    const g = files();
    g.set("assets/one.png", Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]));
    const b = checkEffectEntry(g);
    expect(b.ok && b.id).toBe(a.id);
    if (!b.ok)
      return;
    expect(Buffer.from(b.files.get("assets/one.png")!).includes(secret)).toBe(false);
    expect(effectRasterAssets(b)).toEqual([{ name: "assets/one.png", mime: "image/png", bytes: new Uint8Array(png) }]);
  });
  it("bounds dimensions before browser decode", () => { const f = files(); const large = Buffer.from(png); large.writeUInt32BE(50000, 16); f.set("assets/big.png", large); expect(checkEffectEntry(f)).toMatchObject({ ok: false, problems: [{ problem: "image_dimensions" }] }); });
  it("bounds the aggregate decoded pixel headers before decoding", () => {
    const f = files();
    for (let i = 0; i < 3; i++) {
      const large = Buffer.from(png);
      large.writeUInt32BE(2048, 16);
      large.writeUInt32BE(2048, 20);
      f.set(`assets/p${i}.png`, large);
    }
    expect(checkEffectEntry(f)).toMatchObject({ ok: false, problems: [{ problem: "image_dimensions" }] });
  });
  it("accepts exactly the normalized byte limit and refuses one byte more", () => {
    const initial = checkEffectEntry(files());
    if (!initial.ok)
      throw Error("control");
    const size = initial.files.get("effect.json")!.byteLength;
    const f = files();
    f.set("worker.js", Buffer.alloc(WEB_EFFECT_MAX_BYTES - size, 0x61));
    const a = checkEffectEntry(f);
    expect(a.ok && a.bytes).toBe(WEB_EFFECT_MAX_BYTES);
    f.set("worker.js", Buffer.alloc(WEB_EFFECT_MAX_BYTES - size + 1, 0x61));
    expect(checkEffectEntry(f).ok).toBe(false);
  });
  it("never invokes an accessor in a manifest or override", () => {
    let called = 0;
    const m = manifest();
    Object.defineProperty(m, "owner", { enumerable: true, get() { called++; throw Error("unexpected"); } });
    expect(parseWebEffectManifest(m).ok).toBe(false);
    const override = {};
    Object.defineProperty(override, "count", { enumerable: true, get() { called++; throw Error("unexpected"); } });
    expect(resolveEffectParams(checked(), override).ok).toBe(false);
    expect(called).toBe(0);
  });
  it("refuses an extension/header mismatch and too many assets", () => {
    const f = files();
    f.set("assets/x.jpg", png);
    expect(checkEffectEntry(f).ok).toBe(false);
    f.delete("assets/x.jpg");
    for (let i = 0; i < 17; i++)
      f.set(`assets/p${i}.png`, png);
    expect(checkEffectEntry(f).ok).toBe(false);
  });
  it("checks cursor declaration and actual hotspot", () => { const f = files({ ...manifest(), cursor: { hotspot: [1, 0] } }); f.set("cursor.png", png); expect(checkEffectEntry(f)).toMatchObject({ ok: false, problems: [{ problem: "invalid_hotspot" }] }); const good = files({ ...manifest(), cursor: { hotspot: [0, 0] } }); good.set("cursor.png", png); expect(checkEffectEntry(good).ok).toBe(true); });
  it("snapshots each source before later input processing can change it", () => {
    const source = Buffer.from("agend.ready()"), before = Buffer.from(source), metadata = Buffer.from(JSON.stringify(manifest()));
    const length = metadata.byteLength;
    Object.defineProperty(metadata, "byteLength", { get() { source.fill(0xff); return length; } });
    const a = checkEffectEntry(new Map([["worker.js", source], ["effect.json", metadata]]));
    expect(a.ok).toBe(true);
    if (!a.ok)
      return;
    expect(Buffer.from(a.files.get("worker.js")!)).toEqual(before);
  });
  it("takes independent normalized snapshots of mutable upload bytes", () => {
    const f = files();
    const a = checkEffectEntry(f);
    expect(a.ok).toBe(true);
    if (!a.ok)
      return;
    const before = Buffer.from(a.files.get("worker.js")!);
    f.get("worker.js")!.fill(0);
    expect(Buffer.from(a.files.get("worker.js")!)).toEqual(before);
  });
});
describe("#1629 CW1 typed placement params", () => {
  it("resolves defaults and stores only differences", () => { const result = resolveEffectParams(checked(), { count: 3, enabled: true, tone: "#aabbcc" }); expect(result).toEqual({ ok: true, values: { count: 3, enabled: true, tone: "#aabbcc", mode: "calm", speed: 0.5 }, overrides: { count: 3 } }); });
  it.each([{ other: 1 }, { count: 1.5 }, { count: 11 }, { enabled: "true" }, { tone: "red" }, { mode: "unknown" }, { speed: 0.3 }, { count: NaN }])("refuses invalid override %j", override => expect(resolveEffectParams(checked(), override).ok).toBe(false));
  it("does not admit inherited schema keys", () => { expect(resolveEffectParams(checked(), { constructor: 1 }).ok).toBe(false); });
});
describe("#1629 CW1 boundary controls", () => {
  it("bounds raw input and manifest before parsing", () => {
    const raw = files();
    raw.set("assets/x.png", new Uint8Array(8 * 1024 * 1024));
    expect(checkEffectEntry(raw)).toMatchObject({ ok: false, problems: [{ problem: "raw_entry_too_large" }] });
    const large = files();
    large.set("effect.json", Buffer.alloc(64 * 1024 + 1, 0x20));
    expect(checkEffectEntry(large)).toMatchObject({ ok: false, problems: [{ path: "effect.json", problem: "manifest_too_large" }] });
  });
  it("limits the parameter declarations to sixteen and rejects duplicate declarations", () => {
    const params = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`p${i}`, { type: "bool", default: true }]));
    expect(checkEffectEntry(files({ ...manifest(), params })).ok).toBe(true);
    expect(checkEffectEntry(files({ ...manifest(), params: { ...params, extra: { type: "bool", default: true } } })).ok).toBe(false);
    for (const delta of [{ regions: ["chat", "chat"] }, { wants: ["state", "state"] }])
      expect(checkEffectEntry(files({ ...manifest(), ...delta })).ok).toBe(false);
  });
  it("refuses reversed numeric bounds, nonfinite defaults, duplicate enums and executable params", () => {
    for (const p of [{ type: "int", min: 10, max: 0, default: 2 }, { type: "number", min: 0, max: 1, default: 2 }, { type: "number", min: 0, max: 1, default: Infinity }, { type: "enum", values: ["a", "a"], default: "a" }, { type: "bool", default: () => true }])
      expect(parseWebEffectManifest({ ...manifest(), params: { x: p } }).ok).toBe(false);
  });
  it("requires declared poster/cursor files, and gives an undeclared poster a canonical declaration", () => {
    expect(checkEffectEntry(files({ ...manifest(), poster: "poster.png" })).ok).toBe(false);
    expect(checkEffectEntry(files({ ...manifest(), cursor: { hotspot: [0, 0] } })).ok).toBe(false);
    const missing = files();
    missing.set("cursor.png", png);
    expect(checkEffectEntry(missing).ok).toBe(false);
    const f = files();
    f.set("poster.png", png);
    const a = checkEffectEntry(f);
    expect(a.ok && a.manifest.poster).toBe("poster.png");
    expect(a.ok && effectRasterAssets(a)).toEqual([]);
  });
  it("caps cursor dimensions and normalized bytes independently", () => {
    const withCursor = () => files({ ...manifest(), cursor: { hotspot: [0, 0] } });
    const wide = Buffer.from(png);
    wide.writeUInt32BE(65, 16);
    wide.writeUInt32BE(65, 20);
    const f = withCursor();
    f.set("cursor.png", wide);
    expect(checkEffectEntry(f)).toMatchObject({ ok: false, problems: [{ problem: "invalid_cursor" }] });
    const chunk = Buffer.alloc(33 * 1024 + 12);
    chunk.writeUInt32BE(33 * 1024);
    chunk.write("IDAT", 4);
    f.set("cursor.png", Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]));
    expect(checkEffectEntry(f)).toMatchObject({ ok: false, problems: [{ problem: "invalid_cursor" }] });
  });
  it.each([
    "// draw the next frame\nagend.ready()",
    '// fetch("https://private.invalid") and import("example") are not used\nagend.ready()',
    '/* WebSocket, importScripts and "//private.invalid" are only comments */ agend.ready()',
    'const ratio = 8 / 2; // animation ratio\nagend.ready()',
    'const pattern = /https?:\\/\\//; // a regex pattern, no network call\nagend.ready()',
  ])("does not lint comments as network/import use: %s", code => {
    const f = files(); f.set("worker.js", Buffer.from(code));
    const result = checkEffectEntry(f); expect(result.ok).toBe(true); expect(result.ok && result.warnings).toEqual([]);
  });
  it.each([
    'const url = "//example.invalid/a"; agend.ready()',
    "const url = '//example.invalid/a'; agend.ready()",
    'const url = `//example.invalid/a`; agend.ready()',
    'const url = "https://example.invalid/a"; agend.ready()',
    '/* comment */ fetch("relative"); agend.ready()',
    'import/* comment */("module.js"); agend.ready()',
    'const url = "http://example.invalid/a"; // comment\nagend.ready()',
  ])("retains advisory warnings for actual URL literals or APIs: %s", code => {
    const f = files(); f.set("worker.js", Buffer.from(code));
    const result = checkEffectEntry(f); expect(result.ok).toBe(true); expect(result.ok && result.warnings).toEqual(["network_or_import_api_unsupported"]);
  });
  it("returns generic lint tags without executing or echoing script text", () => {
    const f = files();
    f.set("worker.js", Buffer.from('fetch("https://private.invalid/token-secret"); agend.ready();'));
    const a = checkEffectEntry(f);
    expect(a.ok && a.warnings).toEqual(["network_or_import_api_unsupported"]);
    const bad = files();
    bad.set("worker.js", Buffer.from('const secret-private ='));
    const b = checkEffectEntry(bad);
    expect(b.ok).toBe(false);
    expect(JSON.stringify(b)).not.toContain("secret-private");
  });
});
