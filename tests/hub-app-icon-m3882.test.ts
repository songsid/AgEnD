/**
 * M-3882: an installed AgEnD Hub has its own icon and name, so it can be told apart from an installed AgEnD dashboard
 * (they looked identical in the taskbar, dock and app list). The Hub's listener serves the Hub's icon set and manifest at
 * the same paths; the dashboard's are unchanged; a fleet's custom app icon never applies to the Hub.
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appManifest, handleWebIconRequest, withAppIconLinks, useAppIconStore } from "../src/web-icons.js";

const ICONS = join(process.cwd(), "src", "ui", "icons");
const file = (name: string) => readFileSync(join(ICONS, name));
function get(path: string, flavor?: "fleet" | "hub", method = "GET") {
  const req = Object.assign(new EventEmitter(), { method, url: path, headers: { host: "localhost" } }) as unknown as IncomingMessage;
  let status = 0, headers: Record<string, string> = {}, body = Buffer.alloc(0);
  const res = { writeHead: (code: number, h: Record<string, string> = {}) => { status = code; headers = h; }, end: (b?: Buffer) => { if (b) body = Buffer.from(b); } } as unknown as ServerResponse;
  const handled = handleWebIconRequest(req, res, path.split("?")[0]!, flavor);
  return { handled, status, headers, body };
}
/** A PNG's width and height from its IHDR. */
const size = (b: Buffer) => [b.readUInt32BE(16), b.readUInt32BE(20)];

describe("M-3882: the Hub's own app icon", () => {
  it("the Hub's manifest is named AgEnD Hub and lists any and maskable icons at 192 and 512; the dashboard's is unchanged", () => {
    const hub = JSON.parse(appManifest("hub"));
    expect([hub.name, hub.short_name, hub.start_url, hub.display]).toEqual(["AgEnD Hub", "AgEnD Hub", "/", "standalone"]);
    expect(hub.icons.map((i: any) => [i.src.split("?")[0], i.sizes, i.purpose])).toEqual([
      ["/icon-192.png", "192x192", "any"], ["/icon-512.png", "512x512", "any"],
      ["/icon-maskable-192.png", "192x192", "maskable"], ["/icon-maskable-512.png", "512x512", "maskable"]]);
    const fleet = JSON.parse(appManifest());
    expect([fleet.name, fleet.short_name, fleet.icons.length]).toEqual(["AgEnD", "AgEnD", 2]);
  });
  it("the Hub listener serves the Hub's files at the dashboard's paths, versioned hub-1; the dashboard still serves its own", () => {
    const pairs: Array<[string, string, string]> = [["/favicon.svg", "hub-favicon.svg", "favicon.svg"], ["/favicon.ico", "hub-favicon.ico", "favicon.ico"],
      ["/apple-touch-icon.png", "hub-apple-touch-icon.png", "apple-touch-icon.png"], ["/icon-192.png", "hub-icon-192.png", "icon-192.png"], ["/icon-512.png", "hub-icon-512.png", "icon-512.png"]];
    for (const [path, hubFile, fleetFile] of pairs) {
      const h = get(`${path}?v=hub-1`, "hub"), f = get(path);
      expect([h.handled, h.status], path).toEqual([true, 200]);
      expect(h.body.equals(file(hubFile)), `${path} is the Hub's`).toBe(true);
      expect(h.headers["Cache-Control"]).toBe("public, max-age=31536000, immutable");
      expect(f.body.equals(file(fleetFile)), `${path} on the dashboard is unchanged`).toBe(true);
      expect(h.body.equals(f.body), `${path} differs`).toBe(false);
    }
    for (const n of [192, 512]) {
      const m = get(`/icon-maskable-${n}.png?v=hub-1`, "hub");
      expect([m.status, size(m.body)]).toEqual([200, [n, n]]);
      expect(get(`/icon-maskable-${n}.png`).handled, "the dashboard has no maskable pair").toBe(false);
    }
    expect(JSON.parse(get("/manifest.webmanifest", "hub").body.toString()).name).toBe("AgEnD Hub");
    expect(get("/not-an-icon.png", "hub").handled).toBe(false);
    expect(get("/favicon.ico", "hub", "POST").status).toBe(405);
  });
  it("every Hub PNG is its stated size; the favicon.ico carries 16, 32 and 64", () => {
    expect(size(file("hub-icon-192.png"))).toEqual([192, 192]);
    expect(size(file("hub-icon-512.png"))).toEqual([512, 512]);
    expect(size(file("hub-apple-touch-icon.png"))).toEqual([180, 180]);
    const ico = file("hub-favicon.ico");
    expect([ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([1, 3]);
    expect([0, 1, 2].map((i) => ico.readUInt8(6 + 16 * i))).toEqual([16, 32, 64]);
  });
  it("the Hub's mark is the dashboard's inverted (a blue tile, light Ag) with the hub badge: told apart at 16 px by colour", () => {
    const hub = file("hub-favicon.svg").toString(), fleet = file("favicon.svg").toString();
    expect(fleet).toContain('fill="#e5eaf0" stroke="#617386"');                        // the dashboard's light tile
    expect(hub).toContain('rx="12" fill="#1d5fae"');                                    // the Hub's blue tile, clear on light and dark
    expect(hub).toMatch(/<g fill="#e5eaf0" fill-rule="evenodd">/);                     // the same Ag, light
    expect(hub).toMatch(/<circle cx="51" cy="7.5"/);                                    // the badge
  });
  it("the Hub's page links hub-1 icons (with the SVG) even when the fleet has a custom app icon; the dashboard's links follow its own", () => {
    useAppIconStore({ current: () => ({ version: "abc" }) as any, file: () => null });
    try {
      const page = "<head><!--app-icon--><!--/app-icon-->\n</head>";
      const hub = withAppIconLinks(page, "hub"), fleet = withAppIconLinks(page);
      expect(hub).toContain('href="/favicon.svg?v=hub-1"');
      expect(hub).toContain('href="/manifest.webmanifest?v=hub-1"');
      expect(fleet).toContain("v=abc");
      expect(fleet).not.toContain("favicon.svg");                                       // a custom fleet icon drops the bundled SVG, as before
    } finally { useAppIconStore(null); }
  });
  it("the Hub listener and the Hub's page shell use the Hub flavor", () => {
    expect(readFileSync(join(process.cwd(), "src", "hub", "http", "compose.ts"), "utf8")).toContain('handleWebIconRequest(req, res, path, "hub")');
    expect(readFileSync(join(process.cwd(), "src", "web-api.ts"), "utf8")).toContain('withAppIconLinks(page, "hub").replace("<body>", body)');
  });
});
