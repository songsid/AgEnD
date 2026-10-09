import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";

/**
 * The "Connections & Bots" row carries up to ten short facts. On v2.1.7 it was a plain
 * non-wrapping flex row, so each fact shrank and wrapped inside its own box ("存取模式:" and
 * "設定" broke mid-word) and the tail was clipped by the card. The layout itself was checked in a
 * real browser at nine widths in two languages; these pin the rules that make it hold.
 *
 * #1408 step 3: the rows are the app shell's (src/ui/shared/app.css, .s-row and its parts), and a connection's row
 * is rendered here in the mini DOM, so the placement of its facts is checked on what the panel builds.
 */
const css = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.css"), "utf8");
const rule = (selector: string): string => {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("}", start));
};

describe("Settings › Connections & Bots row layout", () => {
  it("wraps between facts, not inside them", () => {
    expect(rule(".s-row")).toContain("flex-wrap: wrap");
    // Every fact is a no-wrap run: a word never breaks inside one.
    const nowrap = rule(".s-name") + rule(".s-meta") + rule(".tag");
    expect(nowrap).toContain("white-space: nowrap");
    expect(rule(".s-actions")).toContain("flex-wrap: wrap");
  });

  it("lets long values stop at their card: the value is clipped, the row never widens past it", () => {
    // The new row clips a long value with an ellipsis rather than breaking it anywhere (the old .conn-row .sub).
    expect(rule(".s-meta")).toContain("max-width: 16em");
    expect(rule(".s-meta")).toContain("overflow: hidden");
    expect(rule(".s-meta")).toContain("text-overflow: ellipsis");
    expect(rule(".s-name")).toContain("max-width: 14em");
  });

  it("keeps the Settings button and its actions together at the end", () => {
    expect(rule(".s-actions")).toContain("margin-left: auto");
  });
});

describe("Settings › Connections & Bots row, as rendered", () => {
  const schema = buildSettingsImpactSchema();
  let p: AppPage;
  const realFetch = (globalThis as any).fetch;
  const world = {
    fleet: { defaults: { backend: "claude-code" }, instances: {}, channels: [{ id: "dc", type: "discord", bot_token_env: "DISCORD_TOKEN", group_id: "g1", access: { mode: "locked", allowed_users: [111] } }] },
  };
  const fakeFetch = async (path: string) => {
    const body = (() => {
      if (path === "/api/settings/schema") return schema;
      if (path === "/api/settings/fleet/raw") return world.fleet;
      if (path === "/api/settings/classic") return { channels: {}, defaults: {} };
      if (path === "/api/settings/connections") return [{ id: "dc", token_present: true }];
      if (path === "/api/fleet") return { version: "2.1.12", instances: [] };
      if (path === "/api/settings/status-emojis") return { keys: [], builtins: { discord: {}, telegram: {} }, telegram_allowed: [], suggestions: [] };
      return [];
    })();
    return { ok: true, status: 200, json: async () => body };
  };
  beforeAll(() => { p = page({ url: "http://127.0.0.1:19280/settings" }); (globalThis as any).fetch = fakeFetch; });
  afterAll(() => { p.restore(); (globalThis as any).fetch = realFetch; });
  afterEach(async () => {
    await p.unmount();
  });

  it("a connection's row: its facts come before one cluster, and that cluster holds the Settings button, token and connection state", async () => {
    const { SettingsPanel } = await import("/ui/js/panel-settings.js");
    await p.mount(h(SettingsPanel, { route: { panel: "settings", section: "bots" }, navKey: "settings:bots" }));
    await settle(12);
    const row = p.root.querySelector(".s-list .s-row")!;
    expect(row).not.toBeNull();
    const facts = row.children.map((c: any) => c.className.split(" ")[0]);
    // The row's own parts, in order: the status dot, the name, the id, the token env, the group, the access mode,
    // the users, the token state, the connection state, and the action cluster last.
    expect(facts.slice(0, 2)).toEqual(["dot", "s-name"]);
    expect(facts.at(-1)).toBe("s-actions");
    // The status and the token belong with the Settings button, at the end of the row (the old .row-end).
    const end = row.children.at(-1)!;
    expect(end.querySelector("button")!.textContent.trim()).toBe("Settings");
    expect(end.textContent).toContain("Token configured");
    expect(end.textContent).toContain("Connected");
    // The facts before it are not in the cluster.
    expect(row.children.slice(0, -1).map((c: any) => c.textContent).join(" ")).toContain("DISCORD_TOKEN");
    expect(end.textContent).not.toContain("DISCORD_TOKEN");
  });
});
