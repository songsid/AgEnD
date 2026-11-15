/**
 * M-3125 PR1 (UI): a room message's files reach the shared thread as attachments, mapped the way the 1:1 chat maps them
 * (hubFileAttachment): an image inline through the Hub's own route, any other file as a download card (an .html one gets the
 * shared thread's preview card), and anything that is not a Hub room file URL is dropped. The same mapping serves a direct
 * room opened through the rooms page, which dropped its files before.
 */
import { beforeAll, expect, it } from "vitest";
import { page } from "./helpers/app-harness.js";

let thread: any;
beforeAll(async () => {
  const pg = page({ url: "http://127.0.0.1:19280/ui", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
  thread = await import("/ui/js/hub-room-thread.js"); pg.restore();
});
const ROOM = "11111111-2222-4333-8444-555555555555";
const file = (id: string, name: string, mime: string) => ({ id, name, size: 10, mime, url: `/hub/v1/rooms/${ROOM}/files/${id}` });
const msg = (files: unknown[], text = "") => ({ id: "m1", roomId: ROOM, at: 1, author: { kind: "person", id: "p2", name: "Bea" }, text, mentions: [], files });

it("maps a post's files to the thread's attachments: images inline, others as downloads, bad URLs dropped", () => {
  const png = file("aaaaaaaa-0000-4000-8000-000000000001", "plan.png", "image/png"), html = file("aaaaaaaa-0000-4000-8000-000000000002", "report.html", "text/html");
  const bad = { ...file("aaaaaaaa-0000-4000-8000-000000000003", "x.txt", "text/plain"), url: "https://elsewhere.example/x" };
  const [m] = thread.toThreadMessages([msg([png, html, bad], "see these")], { meId: "p1", ids: new Map() });
  expect(m.attachments).toEqual([
    { id: "aaaaaaaa000040008000000000000001", name: "plan.png", size: 10, mime: "image/png", url: `${png.url}/inline`, kind: "photo" },
    { id: "aaaaaaaa000040008000000000000002", name: "report.html", size: 10, mime: "text/html", url: html.url },
  ]);
  expect(m.text).toBe("see these");
});

it("a files-only post is a message with attachments and no text; a post without files has no attachments field", () => {
  const [only] = thread.toThreadMessages([msg([file("aaaaaaaa-0000-4000-8000-000000000004", "a.csv", "text/csv")])], { meId: "p1", ids: new Map() });
  expect(only.attachments).toHaveLength(1); expect(only.text).toBe("");
  const [plain] = thread.toThreadMessages([msg([], "hello")], { meId: "p1", ids: new Map() });
  expect(plain).not.toHaveProperty("attachments");
});

it("PR2: an agent's answer with files and no text is drawn (it is not an empty answer still to come)", () => {
  const ask = { id: "q1", roomId: ROOM, at: 1, author: { kind: "person", id: "p1", name: "Me" }, text: "@Notes table?", mentions: ["n"] };
  const answer = { id: "a1", roomId: ROOM, at: 2, author: { kind: "agent", id: "n", name: "Notes", owner: { name: "Olivia" } }, text: "", mentions: [], answerTo: "q1", stage: "answered",
    files: [file("aaaaaaaa-0000-4000-8000-000000000005", "table.csv", "text/csv")] };
  const view = thread.toThreadMessages([ask, answer], { meId: "p1", ids: new Map() });
  expect(view.find((m: any) => m.roomMessage === "a1")?.attachments).toHaveLength(1);
});
