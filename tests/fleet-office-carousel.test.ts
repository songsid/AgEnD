/**
 * #4010: the Office carousel's pure helpers (fleet-office-carousel.js) — offered with two offices; the switcher id is
 * none an office can have; saved ids and interval; wrap; keyboard / remote keys.
 */
import { describe, expect, it } from "vitest";
import {
  CAROUSEL_ID, INTERVAL_DEFAULT, INTERVAL_MAX, INTERVAL_MIN, INTERVALS,
  carouselHeld, carouselIdsOk, carouselKey, carouselOk, carouselSavedOk, intervalOk, nextIndex, prevIndex,
} from "../src/ui/fleet-office-carousel.js";

const TWO = [{ id: "front", name: "Front desk" }, { id: "lab", name: "Lab" }];
const THREE = [...TWO, { id: "ward", name: "Ward" }];

describe("Office carousel: the pure part (fleet-office-carousel.js)", () => {
  it("offered with two or more stored offices; its id is none an office can have", () => {
    expect([carouselOk([]), carouselOk([TWO[0]]), carouselOk(TWO), carouselOk(null)]).toEqual([false, false, true, false]);
    expect(CAROUSEL_ID).toBe("*carousel");
    expect(/^[A-Za-z0-9_-]{1,40}$/.test(CAROUSEL_ID)).toBe(false);   // '*' is never in a stored office's id
  });
  it("the interval is clamped; the menu is 15s–10 min", () => {
    expect([intervalOk(30), intervalOk(15), intervalOk(600), intervalOk(1), intervalOk(9999), intervalOk("no"), intervalOk(undefined), intervalOk(null)])
      .toEqual([30, INTERVAL_MIN, INTERVAL_MAX, INTERVAL_MIN, INTERVAL_MAX, INTERVAL_DEFAULT, INTERVAL_DEFAULT, INTERVAL_DEFAULT]);
    expect(INTERVALS).toEqual([15, 30, 60, 120, 300, 600]);
  });
  it("ids: nothing saved yet is every stored office; a list keeps stored order and drops gone / odd ones", () => {
    expect(carouselIdsOk(null, TWO)).toEqual(["front", "lab"]);
    expect(carouselIdsOk(undefined, THREE)).toEqual(["front", "lab", "ward"]);
    expect(carouselIdsOk(["lab", "front"], THREE)).toEqual(["front", "lab"]);
    expect(carouselIdsOk(["ward", "gone", "*all", "lab"], THREE)).toEqual(["lab", "ward"]);
    expect(carouselIdsOk([], TWO)).toEqual([]);
    expect(carouselIdsOk(["front"], [])).toEqual([]);
  });
  it("what is kept: unique office-shaped ids, a clamped interval; junk becomes empty ids and the default interval", () => {
    expect(carouselSavedOk(null)).toEqual({ ids: [], interval: INTERVAL_DEFAULT });
    expect(carouselSavedOk({ ids: ["front", "front", "lab", "../x", "*all", "a".repeat(41)], interval: 12 }))
      .toEqual({ ids: ["front", "lab"], interval: INTERVAL_MIN });
    expect(carouselSavedOk({ ids: "front", interval: 120 })).toEqual({ ids: [], interval: 120 });
    expect(carouselSavedOk({ ids: ["ok"], interval: "no" })).toEqual({ ids: ["ok"], interval: INTERVAL_DEFAULT });
  });
  it("next and previous wrap", () => {
    expect([nextIndex(0, 3), nextIndex(2, 3), nextIndex(1, 2)]).toEqual([1, 0, 0]);
    expect([prevIndex(0, 3), prevIndex(2, 3), prevIndex(0, 1)]).toEqual([2, 1, 0]);
    expect([nextIndex(0, 0), prevIndex(4, 0)]).toEqual([0, 0]);
  });
  it("Space pauses; arrows and N / P and media keys step; repeats and modifiers do nothing", () => {
    expect(carouselKey({ key: " " })).toBe("pause");
    expect(carouselKey({ key: "MediaPlayPause" })).toBe("pause");
    expect(carouselKey({ key: "ArrowRight" })).toBe("next");
    expect(carouselKey({ key: "n" })).toBe("next");
    expect(carouselKey({ key: "MediaTrackNext" })).toBe("next");
    expect(carouselKey({ key: "ArrowLeft" })).toBe("prev");
    expect(carouselKey({ key: "P" })).toBe("prev");
    expect(carouselKey({ key: "MediaTrackPrevious" })).toBe("prev");
    expect(carouselKey({ key: " ", repeat: true })).toBeNull();
    expect(carouselKey({ key: "ArrowRight", ctrlKey: true })).toBeNull();
    expect(carouselKey({ key: "f" })).toBeNull();
    expect(carouselKey(null)).toBeNull();
  });
  it("a focused field, button or link keeps Space and arrows; nothing focused does not", () => {
    expect(carouselHeld(null)).toBe(false);
    expect(carouselHeld({ tagName: "BODY" })).toBe(false);
    expect(carouselHeld({ tagName: "CANVAS" })).toBe(false);
    expect(carouselHeld({ tagName: "INPUT" })).toBe(true);
    expect(carouselHeld({ tagName: "SELECT" })).toBe(true);
    expect(carouselHeld({ tagName: "BUTTON" })).toBe(true);
    expect(carouselHeld({ tagName: "A" })).toBe(true);
    expect(carouselHeld({ tagName: "TEXTAREA" })).toBe(true);
    expect(carouselHeld({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(carouselHeld({ tagName: "SPAN", closest: (sel: string) => sel.includes("button") ? {} : null })).toBe(true);
  });
});
