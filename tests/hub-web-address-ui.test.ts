/**
 * M-2901 (#3428): fleet Settings → Hub → "Hub address", the host owner's card over the merged D3 route
 * (/api/settings/hub/web-address, /prepare, /commit). Through the real card and its real client, with fetch answered here:
 * - what it shows; Change → one address field → Check (prepare) → Confirm (commit) with the prepared ref, and each outcome;
 * - where the Hub listens and which certificate it uses, derived from the address (and set by hand under Advanced);
 * - each refusal said in words (never a raw code), the private key not kept after it was sent, a non-owner sees nothing;
 * - the page mark: only for the host owner's own shell on a fleet with a Hub, never over the public link.
 */
import { afterEach, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { serveAppShell } from "../src/web-api.js";

const FP = "AB:CD:".repeat(15) + "EF:01";
// Stand-in PEM text (not a key): the markers are assembled so secret scanners don't take the fixture for one.
const pem = (label: string, body: string) => `${"-".repeat(5)}BEGIN ${label}${"-".repeat(5)}\n${body}\n${"-".repeat(5)}END ${label}${"-".repeat(5)}`;
const CERT = pem("CERTIFICATE", "AAA"), KEY = pem(["PRIVATE", "KEY"].join(" "), "BBB");
const NOW = { ok: true, origin: "https://hub.example.com:8443", listen: { host: "0.0.0.0", port: 8443 }, certificate: { fingerprint256: FP, validTo: "Nov 13 00:00:00 2027 GMT", selfSigned: true } };
type Answer = { status?: number; body: unknown };
const mounted: AppPage[] = [];
afterEach(async () => { for (const pg of mounted.splice(0)) { await pg.unmount(); pg.restore(); } delete (globalThis as any).fetch; });
const until = async (test: () => unknown) => { for (let i = 0; i < 120 && !test(); i++) await settle(3); };

async function fixture(opts: { language?: string; read?: Answer; prepare?: (body: any) => Answer; commit?: (body: any) => Answer } = {}) {
  const pg = page({ url: "http://127.0.0.1:19280/settings/hub", storage: { agend_tour_done: "1" } }); mounted.push(pg);
  const calls: Array<{ path: string; method: string; body: any }> = [];
  (globalThis as any).fetch = async (path: string, options: any = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, method: options.method ?? "GET", body });
    const a: Answer = path.endsWith("/prepare") ? (opts.prepare ?? (b => ({ body: { ok: true, ref: "r".repeat(32), expiresAt: Date.now() + 300_000,
      summary: { field: "web-address", from: NOW.origin, to: b.origin, listen: b.listen, sessionsEnd: true },
      certificate: { fingerprint256: "12:34", validTo: "Nov 13 00:00:00 2027 GMT", selfSigned: true } } })))(body)
      : path.endsWith("/commit") ? (opts.commit ?? (() => ({ body: { ok: true, receiptId: "x", origin: calls.find(c => c.path.endsWith("/prepare"))!.body.origin, state: "ready" } })))(body)
      : (opts.read ?? { body: NOW });
    return { ok: (a.status ?? 200) < 300, status: a.status ?? 200, json: async () => a.body };
  };
  const i18n = await import("/assets/app-i18n.js"); i18n.setLang(opts.language ?? "en", { store: false });
  const mod = await import("/ui/js/settings-hub-web-address.js");
  await pg.mount(h(mod.HubWebAddressSettings, {})); await settle(6);
  const q = (s: string) => pg.root.querySelector(s) as any;
  const type = async (s: string, v: string) => { const el = q(s); el.value = v; fire(el, "input"); await settle(); };
  const button = (text: string) => (Array.from(pg.root.querySelectorAll("button")) as any[]).find(b => b.textContent.trim() === text);
  const click = async (text: string) => { fire(button(text), "click"); await settle(6); };
  const submit = async () => { fire(q(".hub-addr-form"), "submit"); await settle(6); };
  return { pg, calls, q, type, button, click, submit, mod, text: () => pg.root.textContent as string };
}

describe("M-2901 Settings → Hub → Hub address (the host owner's card)", () => {
  it.each([
    ["en", "Hub address", "Change address", "Check", "Confirm change", "Everyone signs in to the Hub's pages again", "Done. The Hub now answers at hub2.example.com."],
    ["zh-TW", "Hub 位址", "變更位址", "檢查", "確認變更", "所有人（包括你）都要重新登入 Hub 網頁", "完成。Hub 現在使用 hub2.example.com"],
  ])("%s: shows today's address; one field, Check, then Confirm with the prepared ref; the Hub answers at the new address", async (language, title, change, check, confirm, effect, done) => {
    const f = await fixture({ language });
    expect(f.text()).toContain(title);
    expect(f.text()).toContain("hub.example.com:8443");
    expect(f.text()).toContain("0.0.0.0:8443");
    expect(f.text()).toContain(FP);
    expect(f.q(".hub-addr-fp").querySelectorAll("wbr").length).toBe(FP.split(":").length - 1);
    expect(f.text()).not.toMatch(/hubWebAddress\.|err_/);
    await f.click(change);
    await f.type("#hubAddrNew", "hub2.example.com");
    expect(f.button(check)).toBeDefined(); await f.submit();
    await until(() => f.button(confirm));
    // A new host name: a new self-signed certificate; the port follows the address (8443 was the address's own port).
    expect(f.calls[1]).toEqual({ path: "/api/settings/hub/web-address/prepare", method: "POST",
      body: { origin: "https://hub2.example.com", listen: { host: "0.0.0.0", port: 443 }, certificate: { mode: "generate" } } });
    expect(f.text()).toContain(effect);
    expect(f.text()).toContain("hub.example.com:8443");                                    // from
    expect(f.text()).toContain("12:34");                                                   // the new certificate's fingerprint
    await f.click(confirm);
    await until(() => f.text().includes(done));
    expect(f.calls[2]).toEqual({ path: "/api/settings/hub/web-address/commit", method: "POST", body: { ref: "r".repeat(32) } });
    expect(f.q(".hub-web-address a.btn-primary").getAttribute("href")).toBe("https://hub2.example.com");
    expect(f.q(".hub-addr-now a").textContent).toBe("hub2.example.com");                  // the card shows the new address
    expect(f.calls).toHaveLength(3);
  });

  it("the same host name keeps today's certificate; a typed port is the listening port; https and :443 are implied", async () => {
    const f = await fixture();
    await f.click("Change address"); await f.type("#hubAddrNew", "https://hub.example.com:9443/"); await f.submit();
    expect(f.calls[1]!.body).toEqual({ origin: "https://hub.example.com:9443", listen: { host: "0.0.0.0", port: 9443 }, certificate: { mode: "keep" } });
    expect(f.mod.typedOrigin("hub.example.com")).toBe("https://hub.example.com");
    expect(f.mod.typedOrigin("http://hub.example.com")).toBeNull();
    expect(f.mod.shownAddress("https://hub.example.com:443")).toBe("hub.example.com");
    expect(f.mod.shownDate("Nov 13 00:00:00 2027 GMT")).toBe("Nov 13, 2027");                 // the page's language, one line
    expect(f.mod.shownDate("not a date")).toBe("not a date");
    expect(f.q(".hub-addr-fp").innerHTML).toBe("12:<wbr>34");                                 // the prepared one: breaks only after a colon
  });

  it("a forwarded port (the address's port is not the listening one) stays as it is", async () => {
    const f = await fixture({ read: { body: { ...NOW, origin: "https://hub.example.com", listen: { host: "10.0.0.5", port: 8443 } } } });
    await f.click("Change address"); await f.type("#hubAddrNew", "hub.corp.example"); await f.submit();
    expect(f.calls[1]!.body.listen).toEqual({ host: "10.0.0.5", port: 8443 });
  });

  it("Advanced: interface, port and an imported certificate are sent as set; the key is not kept once sent; keep is not offered for another host", async () => {
    const f = await fixture();
    await f.click("Change address"); await f.type("#hubAddrNew", "hub2.example.com");
    const modes = () => (Array.from(f.pg.root.querySelectorAll('input[name="hubAddrCert"]')) as any[]).map(r => r.value);
    expect(modes()).toEqual(["generate", "import"]);
    await f.type("#hubAddrHost", "127.0.0.1"); await f.type("#hubAddrPort", "9000");
    const imp = (Array.from(f.pg.root.querySelectorAll('input[name="hubAddrCert"]')) as any[]).find(r => r.value === "import");
    fire(imp, "change"); await settle(4);
    expect(f.button("Check").disabled).toBe(true);                                         // both PEMs needed
    await f.type("#hubAddrCertPem", CERT);
    await f.type("#hubAddrKeyPem", KEY);
    await f.submit();
    expect(f.calls[1]!.body).toEqual({ origin: "https://hub2.example.com", listen: { host: "127.0.0.1", port: 9000 },
      certificate: { mode: "import", certPem: CERT, keyPem: KEY } });
    await f.click("Back");
    expect(f.q("#hubAddrKeyPem").value).toBe("");                                          // sent once, not kept in the page
    expect(f.q("#hubAddrPort").value).toBe("9000");
  });

  it.each([
    ["port_in_use", 409, "Another program on this computer is using that port."],
    ["port_conflict", 409, "That address or port is the one Fleets connect to."],
    ["certificate", 400, "The certificate doesn't fit"],
    ["busy", 409, "or a device is finishing its sign-in"],
    ["unchanged", 409, "That is already the Hub's address."],
    ["something_new", 503, "The address wasn't changed. Try again."],
  ])("a Check refused with %s says so in words and stays on the form", async (code, status, words) => {
    const f = await fixture({ prepare: () => ({ status, body: { ok: false, code } }) });
    await f.click("Change address"); await f.type("#hubAddrNew", "hub2.example.com"); await f.submit();
    expect(f.q('[role="alert"]').textContent).toContain(words);
    expect(f.text()).not.toMatch(/err_|port_in_use|port_conflict|something_new/);                 // words, never a raw code
    expect(f.q("#hubAddrNew").value).toBe("hub2.example.com");
  });

  it("what the page can tell itself is said before any request: not https, nothing changed", async () => {
    const f = await fixture();
    await f.click("Change address"); await f.type("#hubAddrNew", "http://hub2.example.com"); await f.submit();
    expect(f.q('[role="alert"]').textContent).toContain("That isn't a usable address.");
    await f.type("#hubAddrNew", "hub.example.com:8443"); await f.submit();
    expect(f.q('[role="alert"]').textContent).toContain("That is already the Hub's address.");
    expect(f.calls).toHaveLength(1);
  });

  it("a Confirm that ran out goes back to the form to check again; stopped and unreachable outcomes are said", async () => {
    let answer: Answer = { status: 410, body: { ok: false, code: "expired" } };
    const f = await fixture({ commit: () => answer });
    await f.click("Change address"); await f.type("#hubAddrNew", "hub2.example.com"); await f.submit(); await f.click("Confirm change");
    expect(f.q('[role="alert"]').textContent).toContain("That took too long. Check again.");
    expect(f.q("#hubAddrNew")).not.toBeNull();
    answer = { body: { ok: true, origin: "https://hub2.example.com", state: "off" } };
    await f.submit(); await f.click("Confirm change");
    expect(f.text()).toContain("Saved. The Hub is stopped; it uses the new address when it runs again.");
    expect(f.q(".hub-web-address a.btn-primary")).toBeNull();
    answer = { body: { ok: true, origin: "https://hub3.example.com", state: "saved_unavailable" } };
    await f.click("Change address"); await f.type("#hubAddrNew", "hub3.example.com"); await f.submit(); await f.click("Confirm change");
    expect(f.text()).toContain("Saved, but the Hub doesn't answer at the new address yet. Check that nothing else uses port 443");
  });

  it("someone who is not this computer's host owner sees no card", async () => {
    const denied = await fixture({ read: { status: 403, body: { ok: false, code: "denied" } } });
    expect(denied.q(".hub-web-address")).toBeNull();
    expect(denied.calls).toHaveLength(1);
  });
  it("an unavailable read says so, with nothing to change", async () => {
    const down = await fixture({ read: { status: 503, body: { ok: false, code: "unavailable" } } });
    expect(down.q('.hub-web-address [role="alert"]').textContent).toContain("can't be changed right now");
    expect(down.button("Change address")).toBeUndefined();
  });
});

describe("M-2901 the page mark", () => {
  const shell = (ctx: Record<string, unknown>, gateway = false) => {
    const req = { method: "GET", url: "/settings/hub", headers: { host: "127.0.0.1:19280" }, socket: { remoteAddress: "127.0.0.1" } } as any;
    if (gateway) bindGatewayRequest(req, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: "http://127.0.0.1:19280", isCurrent: () => true });
    let html = ""; serveAppShell(req, { setHeader() {}, writeHead() {}, end(value: string) { html = value; } } as never, ctx as never, "full");
    expect(html).toContain("<body"); return html;
  };
  const hub = { hub: { hubId: "h".repeat(32) } };
  const base = { getRawFleetConfig: () => hub, hubSetupSession: () => ({}), hubWebAddress: async () => ({}) };
  it("is set for the host owner's own shell on a fleet with a Hub, and nowhere else", () => {
    expect(shell(base)).toContain('data-hub-web-address="1"');
    expect(shell(base, true)).not.toContain('data-hub-web-address="1"');                                       // the public link
    expect(shell({ ...base, hubSetupSession: () => null })).not.toContain('data-hub-web-address="1"');        // not the host owner
    expect(shell({ ...base, getRawFleetConfig: () => ({}) })).not.toContain('data-hub-web-address="1"');      // no Hub set up
    expect(shell({ ...base, hubWebAddress: undefined })).not.toContain('data-hub-web-address="1"');           // an older server
  });
});
