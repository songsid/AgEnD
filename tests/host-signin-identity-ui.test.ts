/** Settings → Agents → CLI sign-ins, with the account of each Claude Code sign-in (a masked e-mail and a plan). Fixtures only (example.com). */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";

let answer: () => unknown = () => ({});
const fetchFake = async () => ({ ok: true, status: 200, json: async () => answer() });
let p: AppPage, S: any, i18n: any, shell: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19281/settings/agents", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  shell = await import("/assets/app-shell.js"); i18n = await import("/assets/app-i18n.js");
  S = await import("/ui/js/backend-signin.js");
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => { await p.unmount(); i18n.setLang("en", { store: false }); S.signInStore.set({ loaded: false, login: null, targets: [], structured: null }); shell.shellStore.set({ dialog: null }); });
const mount = async (targets: unknown[]) => { answer = () => ({ login: null, targets }); await p.mount(h(S.SignInList, {})); await settle(6); };
const accounts = () => p.root.querySelectorAll(".s-row").map((row: any) => row.querySelector(".s-host-cli-account")?.textContent ?? null);

describe("the host's CLI sign-ins show which account they are", () => {
  const identity = (maskedEmail: string, plan: string) => ({ maskedEmail, plan });
  it("shows `e-mail · Plan` under each Claude Code sign-in (the default and every profile); nothing under a CLI without one", async () => {
    await mount([
      { backend: "claude-code", state: "usable", signIn: true, identity: identity("al***@example.com", "team") },
      { backend: "codex", state: "usable", signIn: true },
      { backend: "claude-code", profile: "work", state: "usable", signIn: true, identity: identity("bo***@example.org", "max") },
      { backend: "claude-code", profile: "key", state: "usable", signIn: true, identity: { apiKey: true } },
      { backend: "claude-code", profile: "odd", state: "usable", signIn: true, identity: identity("ca***@example.net", "platinum") },
      { backend: "claude-code", profile: "out", state: "not_signed_in", signIn: true },
    ]);
    expect(accounts()).toEqual(["al***@example.com · Team", null, "bo***@example.org · Max", "No account email (API key)", "ca***@example.net · Unknown plan", null]);
    expect(p.root.querySelectorAll(".s-row")[2].querySelector(".s-host-cli-identity small").textContent).toBe("Credential profile: work");
  });
  it("tolerates a server that sends no identity at all (an older one): the list is as it always was", async () => {
    await mount([{ backend: "claude-code", state: "usable", signIn: true }, { backend: "claude-code", profile: "work", state: "usable", signIn: true }]);
    expect(accounts()).toEqual([null, null]); expect(p.root.querySelectorAll(".s-row")).toHaveLength(2);
  });
  it("shows only what is masked: an address that is not in the masked form, or any other field, is not rendered", async () => {
    await mount([{ backend: "claude-code", state: "usable", signIn: true, identity: { maskedEmail: "alice.fixture@example.com", plan: "team", name: "Alice Fixture", orgName: "Fixture Org" } }]);
    expect(accounts()).toEqual(["Team"]); expect(p.root.textContent).not.toMatch(/alice\.fixture|Alice Fixture|Fixture Org/);
  });
  it("is in zh-TW: the labels are translated, the plan names are not", async () => {
    i18n.setLang("zh-TW", { store: false });
    await mount([{ backend: "claude-code", state: "usable", signIn: true, identity: { maskedEmail: "al***@example.com", plan: "enterprise" } }, { backend: "claude-code", profile: "key", state: "usable", signIn: true, identity: { apiKey: true } },
      { backend: "claude-code", profile: "odd", state: "usable", signIn: true, identity: { plan: "unknown" } }]);
    expect(accounts()).toEqual(["al***@example.com · Enterprise", "沒有帳號 email（API key）", "未知方案"]);
  });
});
