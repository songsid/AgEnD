/**
 * #2636 part 3: the Office's Share… dialog and the open links (Settings → Access & security) — what is sent, the URL
 * shown to copy, refusals in words (Cloudflare's 429 says to try again later), Revoke and Revoke all; and the Share…
 * button only for an admin on the dashboard reached directly.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p: AppPage, D: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  D = await import("/ui/js/office-share-dialog.js");
});
afterAll(() => p.restore());

const SHARE = { id: "a1b2c3d4", office: "hq", text: false, owner: "person:discord:1", createdAt: 0, expiresAt: Date.now() + 3_600_000 };
function host(over: { post?: (body: any) => [number, unknown] } = {}) {
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  let shares: any[] = [];
  const get = async (path: string, o: { method?: string; body?: string } = {}) => {
    const method = o.method ?? "GET";
    calls.push({ method, path, ...(o.body ? { body: JSON.parse(o.body) } : {}) });
    const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    if (method === "GET") return reply(200, { enabled: true, shares });
    if (method === "POST") {
      const [status, body] = over.post ? over.post(JSON.parse(o.body!)) : [200, { share: SHARE, url: `https://s.trycloudflare.com/o/${"T".repeat(43)}` }];
      if (status === 200) shares = [SHARE];
      return reply(status, body);
    }
    if (method === "DELETE") { const n = shares.length; shares = []; return reply(n ? 200 : 404, n ? { revoked: n } : { error: "not_found" }); }
    return reply(404, {});
  };
  return { get, calls, setShares: (v: any[]) => { shares = v; } };
}
const OFFICES = [{ id: "hq", name: "HQ" }, { id: "lab", name: "Lab" }];

describe("Share… (#2636)", () => {
  it("sends the office shown, the time and whether lines show; then the URL to copy and until when", async () => {
    const hst = host();
    await p.mount(h(D.ShareDialog, { offices: OFFICES, current: "lab", get: hst.get, onClose: () => {} }));
    await settle(3);
    const [office, time] = p.root.querySelectorAll(".os-form select");
    expect(office.value).toBe("lab");
    expect(office.querySelectorAll("option").map((o: any) => o.value)).toEqual(["all", "hq", "lab"]);
    time.value = "120"; fire(time, "change");
    const box = p.root.querySelector(".os-form input[type=checkbox]");
    box.checked = true; fire(box, "change");
    await settle(1);
    p.root.querySelectorAll(".dlg-actions button").at(-1).click();
    await settle(4);
    expect(hst.calls.find(c => c.method === "POST")?.body).toEqual({ office: "lab", minutes: 120, text: true });
    expect(p.root.querySelector(".os-url").value).toBe(`https://s.trycloudflare.com/o/${"T".repeat(43)}`);
    expect(p.root.querySelector(".os-made .note").textContent).toContain("Anyone with this link can watch until");
    expect(p.root.querySelectorAll(".os-row")).toHaveLength(1);                 // the list read again
    await p.unmount();
  });

  it("a refusal says why: Cloudflare's 429 to try again later; nothing to copy", async () => {
    const hst = host({ post: () => [503, { error: "tunnel", reason: "rate-limited" }] });
    await p.mount(h(D.ShareDialog, { offices: OFFICES, current: null, get: hst.get, onClose: () => {} }));
    await settle(3);
    expect(p.root.querySelector(".os-form select").value).toBe("all");
    p.root.querySelectorAll(".dlg-actions button").at(-1).click();
    await settle(4);
    expect(p.root.querySelector("[role=alert]").textContent).toBe("Cloudflare is limiting new quick tunnels right now. Try again in a few minutes.");
    expect(p.root.querySelector(".os-url")).toBeNull();
    expect(D.refusalText({ error: "too_many" })).toContain("At most 10");
    expect(D.refusalText({ error: "tunnel", reason: "unreachable" })).toContain("(unreachable)");
    await p.unmount();
  });

  it("the open links: Revoke, and Revoke all with more than one; the Settings card says when it is off", async () => {
    const hst = host();
    hst.setShares([{ ...SHARE, office_name: "HQ" }, { ...SHARE, id: "e5f6a7b8", office: "all", text: true }]);
    await p.mount(h(D.OfficeSharesCard, { get: hst.get }));
    await settle(3);
    const rows = p.root.querySelectorAll(".os-row");
    expect(rows.map((r: any) => r.querySelector(".os-what strong").textContent)).toEqual(["HQ", "All offices"]);
    expect(rows[1].textContent).toContain("with status lines");
    p.root.querySelector(".os-all").click();
    await settle(4);
    expect(hst.calls.filter(c => c.method === "DELETE").map(c => c.path)).toEqual(["/ui/office-share/all"]);
    expect(p.root.querySelector(".os-none").textContent).toBe("No share links are open.");
    await p.unmount();
    const off = { get: async () => ({ ok: true, status: 200, json: async () => ({ enabled: false, shares: [] }) }) };
    await p.mount(h(D.OfficeSharesCard, off));
    await settle(3);
    expect(p.root.querySelector(".os-card .note").textContent).toContain("web.office_share.enabled: false");
    await p.unmount();
    const none = { get: async () => ({ ok: false, status: 403, json: async () => ({}) }) };
    await p.mount(h(D.OfficeSharesCard, none));
    await settle(3);
    expect(p.root.querySelector(".os-card")).toBeNull();                       // not this session's: nothing shown
    await p.unmount();
  });
});
