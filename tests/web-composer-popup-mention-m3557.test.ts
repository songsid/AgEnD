import { afterEach, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let pg: AppPage | undefined;
afterEach(async () => { await pg?.unmount(); pg?.restore(); pg = undefined; });
it("M3557: the real Hub mention component retains option mouse handling even inside an opted-in strip", async () => {
  pg = page({ storage: { agend_tour_done: "1" } });
  const { RoomComposer } = await import("/ui/js/hub-room-composer.js" as string);
  const { focusComposerStrip } = await import("/assets/composer-focus.js" as string);
  const send = vi.fn();
  await pg.mount(h("div", { class: "composer-hit", "data-composer-focus": "", onPointerDown: focusComposerStrip, onClick: focusComposerStrip },
    h(RoomComposer, { store: { send }, detail: { room: { id: "example", kind: "group", name: "Example room" }, me: { id: "me" },
      settings: {}, members: [{ kind: "agent", id: "example-agent", name: "Example agent" }] } })));
  await settle();
  const box = pg.root.querySelector("textarea") as any;
  box.value = "@"; box.selectionStart = 1; fire(box, "input"); await settle();
  const row = pg.root.querySelector('[role="option"]') as any;
  expect(row).toBeTruthy();
  const label = row.querySelector(".cmd-name").textContent.trim();
  const down = fire(row.querySelector("span") || row, "pointerdown", { pointerType: "mouse", button: 0 });
  expect(down.defaultPrevented).toBe(false);
  fire(row, "mousedown", { button: 0 }); await settle();
  expect(box.value).toBe(label + " "); expect(send).not.toHaveBeenCalled();
});
