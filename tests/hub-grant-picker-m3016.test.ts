/** Mounted production Hub entry and existing dialog controls; inert API, no account or browser. */
import { afterEach, beforeAll, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { isServedAsset } from "../src/auth-api.js";
let clients: any, panels: any, words: any;
const mounted: AppPage[] = [], id = "aaaaaaaa-1111-4222-8333-444444444444";
const person = { realm: "corp", objectId: "bbbbbbbb-1111-4222-8333-444444444444" }, group = "cccccccc-1111-4222-8333-444444444444", dn = "CN=Engineering,DC=example,DC=test";
beforeAll(async () => {
  const p = page(); clients = await import("/ui/js/hub-client.js"); panels = await import("/ui/js/panel-hub.js"); words = await import("/assets/app-i18n.js"); p.restore();
});
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } clients.setHubClient(null); panels.resetHubSession(); words.setLang("en", { store: false }); });
const until = async (f: () => unknown) => { for (let i = 0; i < 100 && !f(); i++) await settle(5); };
async function mount(mark = true, clientMark = true, overrides: Record<string, (body: any) => unknown> = {}) {
  const calls: any[] = [], c = clients.createHubWebClient({ fetchImpl: async (path: string, options: any) => {
    const body = options.body ? JSON.parse(options.body) : undefined; calls.push({ path, method: options.method, body });
    const data = overrides[path] ? await overrides[path](body) : path === "/hub/v1/session" ? { signedIn: true, admin: false, csrf: "owned-fixture", displayName: "Owner", login: "owner", hub: { name: "Team Hub" }, features: mark ? ["grant-subjects-v1"] : [] }
      : path === "/hub/v1/exposures" ? { mine: [{ id, owner: { realm: "corp", objectId: id }, revision: 3, displayName: "Research", state: "published", grants: [] }], askable: [] }
      : path.endsWith("/grant-subjects/search") ? body.kind === "group" ? { ok: true, groups: [{ objectId: group, cn: "Engineering", dn }], truncated: false } : { ok: true, people: [{ person, login: "alex", displayName: "Alex Chen" }], truncated: false }
      : path.endsWith("/activity") ? { activity: [] } : { pairings: [] };
    const status = (data as any)?.__status ?? 200; return { ok: status < 400, status, headers: new Headers(), json: async () => data };
  } });
  c.grantSubjectsV1 = clientMark; clients.setHubClient(c); panels.resetHubSession();
  const p = page({ url: `http://127.0.0.1/ui/hub/exposures?agent=${id}&grant=1`, storage: { agend_lang: "en", agend_tour_done: "1" } }); mounted.push(p);
  await p.mount(h(panels.HubPanel, { route: { panel: "hub", tab: "exposures" }, navKey: `grant-picker|${mark}|${clientMark}` }));
  await until(() => p.root.querySelector(".hub-grant"));
  return { p, c, calls };
}
it("offers person and AD group selection inside the current owner grant dialog", async () => {
  const { p } = await mount(); await until(() => p.root.querySelector("[data-grant-picker]"));
  expect(p.root.querySelector("[data-grant-picker]")).not.toBeNull();
  expect(p.root.textContent).toContain("Find a person");
  const select = p.root.querySelector("[data-grant-kind]") as any; select.value = "group"; fire(select, "change"); await settle(10);
  expect(p.root.textContent).toContain("Find a group"); expect(p.root.textContent).toContain("Direct members");
  expect(p.root.textContent).toContain("90 days");
});
it("loads the picker's own served stylesheet once, without depending on the shell's cached app.css", async () => {
  const { p } = await mount(); await until(() => p.root.querySelector("[data-grant-picker]"));
  const selector = 'link[data-hub-grant-picker-css="1"]';
  expect(p.document.querySelector(selector)?.getAttribute("href")).toBe("/assets/hub-grant-picker.css");
  expect(isServedAsset("hub-grant-picker.css")).toBe(true);
  const kind = p.root.querySelector("[data-grant-kind]") as any;
  kind.value = "group"; fire(kind, "change"); await settle(5);
  const picker = await import("/ui/js/hub-grant-picker.js"); picker.linkHubGrantPickerCss(p.document);
  expect(p.document.querySelectorAll(selector)).toHaveLength(1);
});
it.each(["person", "group"])("posts the selected immutable %s and exact revision once, with the chosen expiry", async kind => {
  const { p, calls } = await mount(); await until(() => p.root.querySelector("[data-grant-picker]"));
  if (kind === "group") { const s = p.root.querySelector("[data-grant-kind]") as any; s.value = "group"; fire(s, "change"); await settle(5); }
  const q = p.root.querySelector(".hub-grant input[type=search]") as any; q.value = kind === "group" ? "En" : "Al"; fire(q, "input");
  await until(() => p.root.querySelector(".hub-group-hits button"));
  (p.root.querySelector(".hub-group-hits button") as any).click(); await settle(5);
  const days = p.root.querySelector("[data-grant-days]") as any; days.value = "90"; fire(days, "change"); await settle(5);
  fire(p.root.querySelector(".hub-grant")!, "submit"); fire(p.root.querySelector(".hub-grant")!, "submit");
  await until(() => calls.some(c => c.path === "/hub/v1/grants"));
  const writes = calls.filter(c => c.path === "/hub/v1/grants"); expect(writes).toHaveLength(1);
  expect(writes[0].body).toEqual({ exposureId: id, exposureRevision: 3, days: 90,
    subject: kind === "group" ? { kind: "group", group: { realm: "corp", objectId: group }, dn } : { kind: "person", person }, ...(kind === "person" ? { login: "alex" } : {}) });
});
it.each([[false, true], [true, false]])("retains exact-login controls with older server/client marks (%s,%s)", async (server, client) => {
  const { p } = await mount(server, client);
  expect(p.root.querySelector(".hub-grant input")).not.toBeNull();
  expect(p.root.querySelector("[data-grant-picker]")).toBeNull();
});
it("an aborted suggestion body stays unknown instead of becoming an empty successful search", async () => {
  let release!: (v: unknown) => void, entered!: () => void;
  const waiting = new Promise<void>(r => { entered = r; }), abort = new AbortController();
  const c = clients.createHubWebClient({ fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers(), json: () => { entered(); return new Promise(r => { release = r; }); } }) });
  const pending = c.searchGrantSubjects(id, 3, "person", "Al", abort.signal); await waiting; abort.abort(); release({ people: [], truncated: false });
  expect(await pending).toMatchObject({ ok: false, code: "unreachable" });
});

it("a superseded person search cannot replace the newer suggestions", async () => {
  let release!: (v: unknown)=>void,entered=false;
  const path=`/hub/v1/exposures/${id}/grant-subjects/search`;
  const {p,calls}=await mount(true,true,{[path]:body=>body.q==="Al"?new Promise(r=>{entered=true;release=r;}):{ok:true,people:[{person,login:"bob",displayName:"Bob Current"}],truncated:false}});
  await until(()=>p.root.querySelector("[data-grant-picker]"));const q=p.root.querySelector("input[type=search]") as any;q.value="Al";fire(q,"input");await until(()=>entered);
  q.value="Bo";fire(q,"input");await until(()=>p.root.textContent.includes("Bob Current"));release({ok:true,people:[{person,login:"alex",displayName:"Alex Stale"}],truncated:false});await settle(20);
  expect(p.root.textContent).toContain("Bob Current");expect(p.root.textContent).not.toContain("Alex Stale");expect(calls.filter(c=>c.path==="/hub/v1/grants")).toHaveLength(0);
});
it("a401 session end closes a picker with a held read; its late response cannot reopen or grant", async () => {
  let release!: (v: unknown)=>void,entered=false,ended=false;const path=`/hub/v1/exposures/${id}/grant-subjects/search`;
  const {p,c,calls}=await mount(true,true,{[path]:()=>new Promise(r=>{entered=true;release=r;}),[`/hub/v1/exposures/${id}/activity`]:()=>ended?{__status:401,code:"unauthenticated"}:{activity:[]}});
  await until(()=>p.root.querySelector("[data-grant-picker]"));const q=p.root.querySelector("input[type=search]") as any;q.value="Al";fire(q,"input");await until(()=>entered);
  ended=true;await c.activity(id);await settle(10);expect(p.root.querySelector("[data-grant-picker]")).toBeNull();release({ok:true,people:[{person,login:"alex",displayName:"Alex Stale"}],truncated:false});await settle(20);
  expect(p.root.querySelector("[data-grant-picker]")).toBeNull();expect(calls.filter(c=>c.path==="/hub/v1/grants")).toHaveLength(0);
});
