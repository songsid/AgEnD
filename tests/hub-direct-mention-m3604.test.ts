/**
 * M-3604: in a Hub 1:1, a message that @-mentions the agent ("@Desk …") was refused 400 invalid — the shared room composer
 * sends the room's own agent in `mentions` — and the composer said "check the connection". Now the 1:1's own agent may be
 * mentioned (the question goes as written), anything else is still refused, and a refusal says its real reason.
 * Actual Hub HTTP/SQLite with an inert member link; fixture names only.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { page } from "./helpers/app-harness.js";
import type { HubExposure, HubQuestion } from "../src/hub/types.js";

type Rig = Awaited<ReturnType<typeof s3bRig>>;
let r: Rig | undefined;
afterEach(async () => { await r?.close(); r = undefined; });

async function direct() {
  r = await s3bRig();
  const owner = r.addPerson("olivia", "Olivia"); r.addPerson("alex", "Alex");
  const fleetId = randomUUID(), link = r.link(fleetId, owner, 1, []);
  const desk: HubExposure = { id: randomUUID(), fleetId, owner, displayName: "Desk", revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) };
  const other: HubExposure = { ...desk, id: randomUUID(), displayName: "Other" };
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [desk, other] }, link) as never, link);
  const o = await r.signIn("olivia"), a = await r.signIn("alex");
  const g = await r.call(o, "POST", "/hub/v1/grants", { exposureId: desk.id, exposureRevision: 1, login: "alex", days: 7 });
  const room = (await r.call(a, "POST", "/hub/v1/rooms", { exposureId: desk.id, grantId: g.json.grant.id })).json.room.id as string;
  const send = (text: string, mentions?: unknown) => r!.call(a, "POST", `/hub/v1/rooms/${room}/messages`, { idempotencyKey: randomUUID(), text, ...(mentions === undefined ? {} : { mentions }) });
  const questions = () => r!.sent.filter(s => s.frame.type === "question").map(s => (s.frame.payload as HubQuestion).text);
  return { desk, other, send, questions };
}

describe("M-3604 a 1:1 message that @-mentions its agent", () => {
  it("is sent as written when the mention is the room's own agent (as the room composer sends it)", async () => {
    const w = await direct();
    const out = await w.send("@Desk which report is mine?", [w.desk.id]);
    expect(out.status).toBe(200);
    expect(out.json).toMatchObject({ text: "@Desk which report is mine?", mentions: [] });
    await vi.waitFor(() => expect(w.questions()).toEqual(["@Desk which report is mine?"]));
  });
  it("@All in a 1:1 is the same one agent: sent", async () => {
    const w = await direct();
    expect((await w.send("@All agents hello", ["all"])).status).toBe(200);
  });
  it("is still refused for another agent, the room assistant, or a malformed list", async () => {
    const w = await direct();
    for (const mentions of [[w.other.id], [w.desk.id, w.other.id], ["assistant"], "x", Array.from({ length: 65 }, () => w.desk.id)]) {
      const out = await w.send("hello", mentions);
      expect([out.status, out.json.code]).toEqual([400, "invalid"]);
    }
    expect(w.questions()).toEqual([]);
  });
  it("a message without mentions works as before", async () => {
    const w = await direct();
    expect((await w.send("hi")).status).toBe(200);
    expect((await w.send("hi again", [])).status).toBe(200);
  });
});

describe("M-3604 a refused send says why", () => {
  let composer: any, i18n: any;
  beforeAll(async () => {
    const pg = page();
    composer = await import("/ui/js/hub-room-composer.js"); i18n = await import("/assets/app-i18n.js");
    pg.restore();
  });
  const say = (lang: "en" | "zh-TW", res: object) => { i18n.setLang(lang, { store: false }); return composer.refusalText(res); };
  it("only a send that got no answer says check the connection; a Hub refusal names its reason", () => {
    expect(say("zh-TW", { ok: false, status: 0, code: "unreachable" })).toBe("沒有送出：沒有送到 AgEnD，請檢查網路連線");
    expect(say("zh-TW", { ok: false, status: 400, code: "invalid" })).toBe("沒有送出：Hub 不接受這則訊息");
    expect(say("zh-TW", { ok: false, status: 401, code: "signed-out" })).toBe("沒有送出：你已登出，請重新登入後再傳送");
    expect(say("zh-TW", { ok: false, status: 403, code: "csrf" })).toBe("沒有送出：這個頁面的登入狀態已變更，請重新整理頁面後再傳送");
    expect(say("zh-TW", { ok: false, status: 429, code: "backpressure" })).toBe("沒有送出：Hub 目前忙碌，請稍候再試");
    expect(say("zh-TW", { ok: false, status: 403, code: "denied" })).toBe("沒有送出：你已經不能再問這個 Agent");
    expect(say("zh-TW", { ok: false, status: 503, code: "unavailable" })).toBe("沒有送出：Hub 暫時無法接收，請再試一次");
    expect(say("zh-TW", { ok: false, status: 409, code: "conflict" })).toBe("沒有送出：Hub 拒絕了這則訊息（conflict）");
    expect(say("en", { ok: false, status: 400, code: "invalid" })).toBe("Not sent: the Hub didn't accept this message");
    expect(say("en", { ok: false, status: 0, code: "unreachable" })).toBe("Not sent: it did not reach AgEnD — check the connection");
    i18n.setLang("en", { store: false });
  });
  it("「重試傳送」 only where sending again can work", () => {
    expect([0, 429, 503].map(status => composer.retryable({ ok: false, status, code: status ? "x" : "unreachable" }))).toEqual([true, true, true]);
    expect([[400, "invalid"], [401, "signed-out"], [403, "denied"], [403, "all-mention-off"]].map(([status, code]) => composer.retryable({ ok: false, status, code }))).toEqual([false, false, false, false]);
  });
});
