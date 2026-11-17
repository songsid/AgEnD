/**
 * alpha.6 feedback (#2), #3324 review F1: Settings → Hub's own guards, drawn by the real module in the mini DOM.
 * - a fleet that runs no Hub: the membership card only — never the Hub host's retention or browser-certificate cards
 *   (they would read "unavailable" on every fleet, and search leads every fleet here);
 * - a Hub host: all three;
 * - over the public link (M-3278, decision 7933bf90): the same cards as locally, for its admin session.
 */
import { afterEach, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";

const mounted: AppPage[] = [];
const until = async (test: () => unknown) => { for (let i = 0; i < 120 && !test(); i++) await settle(3); };
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
afterEach(async () => { for (const pg of mounted.splice(0)) { await pg.unmount(); pg.restore(); } });

async function section(props: { hubHost: boolean; overPublicLink: boolean }) {
  const pg = page({ url: "http://127.0.0.1:19280/settings/hub", storage: { agend_tour_done: "1" } }); mounted.push(pg);
  if (props.overPublicLink) pg.document.body.dataset.publicLink = "1";
  (globalThis as any).fetch = async (path: string) => response(path.split("?")[0] === "/api/settings/hub/membership" ? { ok: true, enabled: false } : { ok: true });
  (await import("/assets/app-i18n.js")).setLang("en", { store: false });
  const { HubSection } = await import("/ui/js/settings-hub-section.js");
  await pg.mount(h(HubSection, props));
  // Each card is its own lazy module: wait for every one this case should draw, then a while longer for any it should not.
  await until(() => pg.root.querySelector("#hub-membership") && (!props.hubHost || pg.root.querySelector(".hub-retention") && pg.root.querySelector(".hub-browser-certificate")));
  await settle(12);
  const has = (sel: string) => !!pg.root.querySelector(sel);
  return { pg, drawn: { membership: has("#hub-membership"), retention: has(".hub-retention"), certificate: has(".hub-browser-certificate"), publicNote: has("#hub-public-link") } };
}

describe("Settings → Hub (#3324 F1)", () => {
  it("a fleet that runs no Hub: the membership card, and neither of the Hub host's cards", async () => {
    expect((await section({ hubHost: false, overPublicLink: false })).drawn).toEqual({ membership: true, retention: false, certificate: false, publicNote: false });
  });
  it("a Hub host: the membership card, retention and the browser certificate", async () => {
    expect((await section({ hubHost: true, overPublicLink: false })).drawn).toEqual({ membership: true, retention: true, certificate: true, publicNote: false });
  });
  it("M-3278: over the public link (a Hub host too): the same cards as locally, and no note", async () => {
    const s = await section({ hubHost: true, overPublicLink: true });
    expect(s.drawn).toEqual({ membership: true, retention: true, certificate: true, publicNote: false });
    expect(s.pg.root.textContent).not.toContain("not over the public link");
  });
});
