/**
 * #2355 review (P3): the project dialog's lead. An edit sends the lead only when it changed — a retired lead (no longer
 * in fleet.yaml, which the server refuses) does not block an unrelated rename — and "" is no lead. The choices offered
 * are the board read's `leads` (web-task-board tests pin that list: the fleet's instances, not a hidden one on the link).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { installDom } from "./helpers/mini-dom.js";

let ui: any;
beforeAll(async () => {
  const base = installDom({ storage: { agend_tour_done: "1" } });
  // @ts-expect-error — a JS module of the app, with no types
  ui = await import("../src/ui/fleet-tasks.js");
  base.restore();
});

describe("what an edit of a project sends", () => {
  it("an unchanged lead (even a retired one) is not sent; a changed one is, and none is null", () => {
    expect(ui.projectPatch("old-lead", { name: "Renamed", description: "", leadInstance: "old-lead" })).toEqual({ name: "Renamed", description: "" });
    expect(ui.projectPatch("old-lead", { name: "Game", description: "", leadInstance: "lead" })).toEqual({ name: "Game", description: "", leadInstance: "lead" });
    expect(ui.projectPatch("old-lead", { name: "Game", description: "", leadInstance: "" })).toEqual({ name: "Game", description: "", leadInstance: null });
    expect(ui.projectPatch(null, { name: "Game", description: "", leadInstance: "" })).toEqual({ name: "Game", description: "" });
  });
});
