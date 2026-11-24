import { afterEach, expect, it } from "vitest";
import { page } from "./helpers/app-harness.js";
const mounted: ReturnType<typeof page>[] = [];
afterEach(() => { for (const p of mounted.splice(0)) p.restore(); });
it.each(["en", "zh-TW"])("the room's terminal lapse is said in the viewer's language (%s)", async lang => {
  const p = page(); mounted.push(p);
  const { setLang } = await import("/assets/app-i18n.js");
  const { toThreadMessages, askReason } = await import("/ui/js/hub-room-thread.js");
  setLang(lang, { store: false });
  const messages = toThreadMessages([{ id: "lapsed-reply", roomId: "planning", at: 1, author: { kind: "agent", id: "notes", name: "Notes" },
    text: "", mentions: [], stage: "not-answered", reasonCode: "share-needs-reshare" }], { meId: "asker", ids: new Map() });
  expect(messages.find((m: any) => m.role === "agent")?.text).toBe(lang === "en"
    ? "This agent is unavailable right now. Its owner needs to share it again." : "這個 Agent 暫時無法回答，擁有者需要重新分享。");
  expect(askReason("share-needs-reshare")).toBe(messages.find((m: any) => m.role === "agent")?.text);
  const direct = toThreadMessages([{ id: "question", at: 1, roomId: "direct", author: { kind: "person", id: "asker", name: "Asker" },
    text: "My question", mentions: [], stage: "not-answered", reasonCode: "share-needs-reshare" }], { meId: "asker", ids: new Map(), direct: true });
  expect(direct.find((m: any) => m.role === "user")?.text).toBe("My question");
  expect(direct.find((m: any) => m.role === "status")?.text).toBe(messages.find((m: any) => m.role === "agent")?.text);
  setLang("en", { store: false });
});
