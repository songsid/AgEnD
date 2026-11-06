import { afterEach, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
const mounted: AppPage[] = [];
afterEach(async () => { for (const pg of mounted.splice(0)) { await pg.unmount(); pg.restore(); } });
const until = async (test: () => unknown) => { for (let i = 0; i < 120 && !test(); i++) await settle(3); };
const revision = "a".repeat(64), reference = "11111111-1111-4111-8111-111111111111";
async function fixture(language: string, conflict = false) {
  const pg = page({ url: "http://127.0.0.1:19280/settings/access", storage: { agend_tour_done: "1" } }); mounted.push(pg);
  const calls: Array<{ path: string; options: any }> = [];
  (globalThis as any).fetch = async (path: string, options: any = {}) => {
    calls.push({ path, options });
    const info = { fingerprint256: "AA:BB:PUBLIC-FINGERPRINT", validTo: "Jan 1 2030 GMT", selfSigned: true };
    return { ok: !conflict || !options.method, status: conflict && options.method ? 409 : 200,
      json: async () => conflict && options.method ? { error: "conflict" } : path.endsWith("/prepare")
        ? { proposal: { reference, revision, certificate: info } } : { certificate: { revision, selected: info, restartRequired: false } } };
  };
  await import("/ui/js/settings-strings.js");
  const i18n = await import("/assets/app-i18n.js"); i18n.setLang(language, { store: false });
  const module = await import("/ui/js/settings-hub-browser-certificate.js");
  await pg.mount(h(module.HubBrowserCertificateSettings, {})); await until(() => pg.root.querySelector("select"));
  return { pg, calls };
}
describe("lazy browser-certificate Settings", () => {
  it.each(["en", "zh-TW"])("owns localized copy in %s and confirms the displayed prepared fingerprint", async language => {
    const { pg, calls } = await fixture(language);
    expect(pg.root.textContent).toContain(language === "en" ? "Hub browser certificate" : "Hub 瀏覽器憑證");
    expect(pg.root.textContent).not.toContain("hubBrowserCertificate.");
    fire(pg.root.querySelector("form")!, "submit"); await until(() => pg.root.querySelector(".hub-certificate-proposal"));
    expect(JSON.parse(calls[1]!.options.body)).toEqual({ mode: "generate", revision });
    const proposal = pg.root.querySelector(".hub-certificate-proposal")!;
    expect(proposal.textContent).toContain("AA:BB:PUBLIC-FINGERPRINT"); expect(proposal.textContent).toContain("Jan 1 2030 GMT");
    expect(proposal.textContent).toContain(language === "en" ? "browsers will warn" : "瀏覽器會顯示警告");
    fire(proposal.querySelector("button")!, "click"); await until(() => calls.length === 3);
    expect(JSON.parse(calls[2]!.options.body)).toEqual({ reference, revision });
    expect(calls[2]!.path).toBe("/api/settings/hub/browser-certificate/apply");
    await until(() => !pg.root.querySelector(".hub-certificate-proposal"));
    expect(pg.root.textContent).toContain(language === "en" ? "New connections use it" : "新連線會使用新憑證");
  });
  it("removes the prepared confirmation when the owner changes the source", async () => {
    const { pg } = await fixture("en");
    fire(pg.root.querySelector("form")!, "submit"); await until(() => pg.root.querySelector(".hub-certificate-proposal"));
    const select = pg.root.querySelector("select") as any; select.value = "import"; fire(select, "change"); await settle();
    expect(pg.root.querySelector(".hub-certificate-proposal")).toBeNull();
  });
  it("accepts paths only in import mode, invalidates the preview on edits and explains a stale proposal", async () => {
    const { pg, calls } = await fixture("en", true);
    const select = pg.root.querySelector("select") as any; select.value = "import"; fire(select, "change"); await settle();
    expect((pg.root.querySelector("form button") as any).disabled).toBe(true);
    const inputs = Array.from(pg.root.querySelectorAll("input")) as any[];
    inputs[0].value = "private/cert.pem"; fire(inputs[0], "input"); inputs[1].value = "private/key.pem"; fire(inputs[1], "input"); await settle();
    fire(pg.root.querySelector("form")!, "submit"); await until(() => calls.length === 2);
    expect(JSON.parse(calls[1]!.options.body)).toEqual({ mode: "import", revision, certificateFile: "private/cert.pem", keyFile: "private/key.pem" });
    await until(() => pg.root.textContent.includes("proposal changed or expired"));
    expect(pg.root.textContent).toContain("proposal changed or expired"); expect(pg.root.querySelector(".hub-certificate-proposal")).toBeNull();
  });
});
