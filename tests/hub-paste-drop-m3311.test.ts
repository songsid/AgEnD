/**
 * M-3311 (1) (Lumen's gap table, docs/design/hub-room-vs-fleet-chat.md #2, #3; Fable's #4151 notes): a Hub conversation —
 * a room and a 1:1 question alike — takes files as the Fleet chat does (panel-chat.js): dragged onto the conversation, they
 * show the drop card and are attached on drop; a long text paste becomes a text file only when there is room for it (else it
 * stays in the box, with the Fleet chat's notice), and says so once attached.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let files: any, app: any, i18n: any;
const mounted: AppPage[] = [];
beforeAll(async () => {
  const pg = page({ url: "http://127.0.0.1:19280/ui/hub", storage: { agend_tour_done: "1" } });
  files = await import("/ui/js/hub-attachments.js"); app = await import("/assets/app-html.js"); i18n = await import("/assets/app-i18n.js");
  await import("/ui/js/chat-strings.js");
  pg.restore();
});
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } i18n.setLang("en", { store: false }); });

function Conversation({ attach }: { attach: any }) {
  const ref = app.useRef(null);
  files.useFileDrop(ref, attach);
  return h("section", { class: "hub-chat-main", ref }, attach ? h(files.DropOverlay, {}) : null, h("div", { class: "thread" }, h("p", {}, "a message")));
}
const drag = (types: string[], list: File[] = []) => ({ dataTransfer: { types, files: list } });

describe("M-3311 (1): drop a file onto a Hub conversation", () => {
  it("files dragged over show the drop card (counted across the messages); a drop attaches them; leaving takes the card away", async () => {
    const pg = page({ url: "http://127.0.0.1:19280/ui/hub", storage: { agend_tour_done: "1" } }); mounted.push(pg);
    const got: File[][] = [];
    await pg.mount(h(Conversation, { attach: { onFiles: async (l: File[]) => { got.push(l); return []; } } })); await settle(5);
    const main = pg.root.querySelector(".hub-chat-main") as any, msg = pg.root.querySelector(".thread p") as any;
    expect(pg.root.querySelector(".drop-overlay")?.textContent).toBe("Drop files to attach them");
    fire(main, "dragenter", drag(["Files"])); fire(msg, "dragenter", drag(["Files"]));
    expect(main.classList.contains("dragging")).toBe(true);
    fire(msg, "dragleave", drag(["Files"]));
    expect(main.classList.contains("dragging"), "still over the conversation").toBe(true);
    expect(fire(main, "dragover", drag(["Files"])).defaultPrevented, "a drop is allowed here").toBe(true);
    const shot = new File([new Uint8Array([1])], "", { type: "image/png" }), doc = new File(["x"], "plan.md", { type: "text/markdown" });
    const dropped = fire(main, "drop", drag(["Files"], [shot, doc]));
    expect([dropped.defaultPrevented, main.classList.contains("dragging")]).toEqual([true, false]);
    expect(got[0]!.map((f) => f.name)).toEqual([expect.stringMatching(/^screenshot-\d{14}\.png$/), "plan.md"]);
    fire(main, "dragenter", drag(["Files"])); fire(main, "dragleave", drag(["Files"]));
    expect(main.classList.contains("dragging")).toBe(false);
    // Text dragged (not files) is not taken.
    fire(main, "dragenter", drag(["text/plain"]));
    expect([main.classList.contains("dragging"), fire(main, "dragover", drag(["text/plain"])).defaultPrevented]).toEqual([false, false]);
  });
  it("a conversation that takes no files: no card, a drop is left alone", async () => {
    const pg = page({ url: "http://127.0.0.1:19280/ui/hub", storage: { agend_tour_done: "1" } }); mounted.push(pg);
    await pg.mount(h(Conversation, { attach: null })); await settle(5);
    const main = pg.root.querySelector(".hub-chat-main") as any;
    fire(main, "dragenter", drag(["Files"]));
    expect([pg.root.querySelector(".drop-overlay"), main.classList.contains("dragging"), fire(main, "drop", drag(["Files"], [new File(["x"], "a.txt")])).defaultPrevented]).toEqual([null, false, false]);
  });
});

describe("M-3311 (1): a long text paste, as the Fleet chat (Fable's #4151 note)", () => {
  const paste = (text: string) => { const e: any = { clipboardData: { files: [], getData: () => text }, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; return e; };
  it("attached as a text file and said so — only once it is attached (a refused upload says nothing more)", async () => {
    const notes: string[] = [], got: File[][] = [];
    let refuse = false;
    const attach = { left: () => 3, notice: (t: string) => notes.push(t), onFiles: async (l: File[]) => { got.push(l); return refuse ? ["it is over 20 MB"] : []; } };
    const e = paste("z".repeat(31230)); files.pasteToAttach(e, attach); await settle(2);
    expect([e.defaultPrevented, got[0]![0]!.name.endsWith(".txt"), notes]).toEqual([true, true, ["A long paste (31,230 characters) was attached as a text file"]]);
    refuse = true; files.pasteToAttach(paste("z".repeat(5000)), attach); await settle(2);
    expect(notes).toHaveLength(1);
  });
  it("no room for another file: the text stays in the box (not stopped), with the Fleet chat's notice; nothing is uploaded", () => {
    const notes: string[] = [], got: File[][] = [];
    const e = paste("z".repeat(5000));
    files.pasteToAttach(e, { left: () => 0, notice: (t: string) => notes.push(t), onFiles: async (l: File[]) => { got.push(l); return []; } });
    expect([e.defaultPrevented, got.length, notes[0]]).toEqual([false, 0, expect.stringContaining("No room for another attachment")]);
  });
});
