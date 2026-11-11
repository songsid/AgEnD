/**
 * M-2885: the AgEnD icon on the desktop shortcuts. templates/icons/agend.ico ("AgEnD 儀表板") and agend-restart.ico
 * ("AgEnD 重新啟動", with a ↻ badge) are built from src/ui/icons/icon-512.png by scripts/build-shortcut-icons.py.
 * - Each holds PNG images at 16, 24, 32, 48, 64 and 256 px (Windows reads PNG entries at every size).
 * - The standalone Windows installer carries exactly these bytes (scripts/embed-shortcut-icons.mjs); `agend shortcuts`
 *   sends the package's own copies. Both copies of the shared shortcut code set IconLocation from them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inflateSync } from "node:zlib";
import { sharedShortcutsPs } from "../src/windows-shortcuts.js";
// @ts-expect-error -- a plain .mjs build script, no type declarations
import { ICON_NAMES, iconBlock } from "../scripts/embed-shortcut-icons.mjs";

const ROOT = join(import.meta.dirname, "..");
const icon = (name: string) => readFileSync(join(ROOT, "templates", "icons", name));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The ICO directory: each entry's declared size and its PNG's own width/height and pixels (RGBA, unfiltered rows). */
function entries(data: Buffer) {
  expect(data.readUInt16LE(0)).toBe(0);
  expect(data.readUInt16LE(2)).toBe(1);                                              // an icon, not a cursor
  const out: Array<{ size: number; png: Buffer; width: number; height: number }> = [];
  for (let i = 0; i < data.readUInt16LE(4); i++) {
    const at = 6 + 16 * i;
    const size = data[at] || 256;
    expect(data[at + 1] || 256).toBe(size);
    const len = data.readUInt32LE(at + 8), offset = data.readUInt32LE(at + 12);
    const png = data.subarray(offset, offset + len);
    expect(png.subarray(0, 8).equals(PNG)).toBe(true);
    out.push({ size, png, width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
  }
  return out;
}

/** The decoded pixels of an 8-bit RGBA PNG (Pillow writes non-interlaced; filters undone here). */
function pixels(png: Buffer): Buffer {
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  expect([png[24], png[25], png[28]]).toEqual([8, 6, 0]);                             // 8-bit, RGBA, not interlaced
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const len = png.readUInt32BE(at), type = png.subarray(at + 4, at + 8).toString("latin1");
    if (type === "IDAT") idat.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = w * 4, out = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!, row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? out[y * stride + x - 4]! : 0, b = y ? out[(y - 1) * stride + x]! : 0, c = x >= 4 && y ? out[(y - 1) * stride + x - 4]! : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      out[y * stride + x] = (row[x]! + pred) & 0xff;
    }
  }
  return out;
}

describe("M-2885: the shortcut icons", () => {
  it.each(ICON_NAMES as string[])("%s: PNG images at 16, 24, 32, 48, 64 and 256 px, each the size it says", (name) => {
    const list = entries(icon(name));
    expect(list.map(e => e.size)).toEqual([16, 24, 32, 48, 64, 256]);
    for (const e of list) expect([e.width, e.height]).toEqual([e.size, e.size]);
  });
  it("the restart icon is the same tile with a badge in its lower right: the top-left quarter is identical, the lower-right is not", () => {
    const plain = entries(icon("agend.ico")), restart = entries(icon("agend-restart.ico"));
    for (const [i, e] of plain.entries()) {
      const a = pixels(e.png), b = pixels(restart[i]!.png), s = e.size, half = Math.floor(s / 2) - 1;
      const at = (x: number, y: number) => (y * s + x) * 4;
      for (let y = 0; y < half; y++) for (let x = 0; x < half; x++) expect(a.readUInt32BE(at(x, y))).toBe(b.readUInt32BE(at(x, y)));
      const corner = at(s - Math.ceil(s * 0.2), s - Math.ceil(s * 0.2));
      expect(a.readUInt32BE(corner)).not.toBe(b.readUInt32BE(corner));
    }
  });
  it("the Windows installer embeds exactly these bytes (scripts/embed-shortcut-icons.mjs), once", () => {
    const installer = readFileSync(join(ROOT, "website", "public", "install-agend.ps1"), "utf8");
    const block = iconBlock();
    expect(installer.split(block)).toHaveLength(2);
    for (const name of ICON_NAMES as string[]) {
      const m = new RegExp(`^  '${name.replace(".", "\\.")}' = \\[Convert\\]::FromBase64String\\('([A-Za-z0-9+/=]+)'\\)$`, "m").exec(installer);
      expect(Buffer.from(m![1]!, "base64").equals(icon(name))).toBe(true);
    }
    // Defined before the first shortcut is made, and handed to both places that make them.
    const defined = installer.indexOf("$AGEND_ICONS = @{");
    expect(defined).toBeGreaterThan(0);
    const calls = [...installer.matchAll(/Install-AgendShortcuts \$\S+ \$\S+ \$AGEND_ICONS\)/g)].map(m => m.index!);
    expect(calls).toHaveLength(2);
    for (const at of calls) expect(at).toBeGreaterThan(defined);
    expect([...installer.matchAll(/@\(Install-AgendShortcuts /g)]).toHaveLength(2);           // no call without the icons
  });
  it("both copies of the shortcut code save the icons beside the scripts and set IconLocation on each shortcut", () => {
    const shared = sharedShortcutsPs();
    const installer = readFileSync(join(ROOT, "website", "public", "install-agend.ps1"), "utf8");
    expect(installer).toContain(shared);
    expect(shared).toContain("if ($icon) { $sc.IconLocation = $icon + ',0' }");
    expect(shared).toMatch(/Save-AgendIcon 'agend\.ico' \$icons\['agend\.ico'\]/);
    expect(shared).toMatch(/Save-AgendIcon 'agend-restart\.ico' \$icons\['agend-restart\.ico'\]/);
    expect(shared).toMatch(/New-AgendShortcut 'AgEnD 儀表板' [^\n]+ \$dashIcon \}/);
    expect(shared).toMatch(/New-AgendShortcut 'AgEnD 重新啟動' [^\n]+ \$restartIcon \}/);
  });
});
