/**
 * #1958 PR B2 (Fable #2006 P2-1): on a page that has no host prefs (no data-prefs, nothing fetched yet), the default
 * places and Turn off colours read this browser's copy — agend_color_show (JSON; anything unreadable is ring + bar) and
 * agend_color_off ("on" only). Its own file: app-prefs takes the page's host values once, when it is first imported.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";

let C: any, prefs: any, pg: AppPage;
beforeAll(async () => {
  pg = page({ url: "http://127.0.0.1:19280/ui", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = async () => { throw new Error("no fetch in this test"); };
  prefs = await import("/assets/app-prefs.js");
  C = await import("/assets/identity-color.js");
});
afterAll(() => pg.restore());

describe("no host prefs on the page: this browser's copy", () => {
  it("the host's values are not known here", () => {
    expect([prefs.prefInForce("color.show"), prefs.prefInForce("color.off")]).toEqual([null, null]);
  });
  it("default places: a stored list is used; unreadable JSON, a bad list or nothing is ring + bar", () => {
    pg.storage.set("agend_color_show", JSON.stringify(["name"]));
    expect(C.defaultPlaces()).toEqual(["name"]);
    pg.storage.set("agend_color_show", JSON.stringify([]));
    expect(C.defaultPlaces(), "nowhere is a choice").toEqual([]);
    for (const bad of ["{not json", JSON.stringify(["glow"]), JSON.stringify(["name", "name"]), JSON.stringify("name")]) {
      pg.storage.set("agend_color_show", bad);
      expect(C.defaultPlaces(), bad).toEqual(["bar", "ring"]);
    }
    pg.storage.delete("agend_color_show");
    expect(C.defaultPlaces()).toEqual(["bar", "ring"]);
  });
  it("Turn off colours: only \"on\" turns them off", () => {
    pg.storage.set("agend_color_off", "on");
    expect(C.colorsOff()).toBe(true);
    for (const other of ["off", "true", "1", ""]) { pg.storage.set("agend_color_off", other); expect(C.colorsOff(), other).toBe(false); }
    pg.storage.delete("agend_color_off");
    expect(C.colorsOff()).toBe(false);
  });
});
