import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { setLocale, t } from "../src/locale.js";
import { TIPS } from "../src/tips.js";
import { dashboardLines } from "../src/next-steps.js";
import { LOGIN_REFUSED_MESSAGE, CODE_REQUEST_REFUSED_MESSAGE } from "../src/auth-api.js";
import { WEB_TOKEN_INVALID_MESSAGE } from "../src/web-auth.js";

// Copy/data only: no fleet, backend, adapter, account or process is constructed.
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const webCopy = (text: string) => { expect(text).toContain("/web"); expect(text).not.toContain("/dashboard"); };
afterEach(() => setLocale("en"));

describe("#1655 advertises /web while keeping the old alias", () => {
  it.each(["en", "zh-TW"] as const)("chat sign-in/revoke/upgrade copy uses /web (%s)", language => {
    setLocale(language);
    for (const key of ["dashboard.public_general", "dashboard.private_link", "dashboard.menu_failed",
      "dashboard.private_failed", "web.public_login_notice", "dashboard.code_help", "dashboard.revoked_not_durable",
      "web.login_notice", "web.resend_code", "upgrade.web_chat", "dashboard.disabled"] as const) webCopy(t(key));
    expect(t("slash.web")).not.toContain("/dashboard");
    expect(t("slash.dashboard")).toContain("/web");
    expect(t("slash.dashboard")).toMatch(/alias|別名/i);
    expect(t("slash.web").length).toBeLessThanOrEqual(100);
    expect(t("slash.dashboard").length).toBeLessThanOrEqual(100);
  });

  it("all four sign-in tips use the advertised name in both languages", () => {
    for (const id of ["tip-051", "tip-134", "tip-224", "tip-302"]) {
      const tip = TIPS.find(tip => tip.id === id)!;
      webCopy(tip.text_en); webCopy(tip.text_zh);
    }
  });

  it("server refusal and first-run messages use /web", () => {
    for (const text of [LOGIN_REFUSED_MESSAGE, CODE_REQUEST_REFUSED_MESSAGE, WEB_TOKEN_INVALID_MESSAGE,
      dashboardLines(19280)[1]]) webCopy(text);
    for (const file of ["src/setup-form.ts", "src/cli.ts", "src/fleet-manager.ts"]) {
      const marker = file.endsWith("setup-form.ts") ? "or send /web to your bot"
        : file.endsWith("cli.ts") ? "or /web in your chat channel" : "open it with /web or `agend web`";
      expect(source(file)).toContain(marker);
    }
  });

  it("shared View translations and the sign-in HTML fallback use /web", () => {
    let view: Record<string, Record<string, string>> | undefined;
    runInNewContext(source("src/ui/shared/view-strings.js").replace(/^import .*;$/m, ""), {
      register: (_namespace: string, dictionary: typeof view) => { view = dictionary; },
    });
    webCopy(view!.en.saveHint); webCopy(view!["zh-TW"].saveHint);
    webCopy(source("src/ui/signin.html"));
  });

  it.each(["README.md", "README.zh-TW.md", "docs/upgrade-2.2.md", "docs/upgrade-2.2.zh-TW.md",
    "docs/web-dashboard.md", "docs/web-dashboard.zh-TW.md", "docs/use-cases.md", "docs/use-cases.zh-TW.md"])("user walkthrough advertises /web: %s", file => {
    webCopy(source(file));
    if (file.includes("web-dashboard")) expect(source(file)).toContain("action: revoke");
  });

  it.each(["docs/SECURITY.md", "docs/SECURITY.zh-TW.md"])("security sign-in/revoke instructions use /web: %s", file => {
    expect(source(file)).toContain("`/web`");
    expect(source(file)).toContain("`/web revoke`");
    expect(source(file)).not.toContain("`/dashboard");
    expect(source(file)).toContain("health/dashboard"); // prose about the listener, not a chat command
  });

  it("the permission table lists /web with its retained alias", () => {
    expect(source("docs/permissions.md")).toContain("`/web` (`/dashboard` alias)");
  });

  it.each(["docs/commands.md", "docs/command-surface.md", "docs/command-surface.zh-TW.md",
    "docs/features.md", "docs/features.zh-TW.md", "docs/cli.md", "docs/cli.zh-TW.md"])("reference table puts /web before its retained alias: %s", file => {
    const rows = source(file).split("\n").filter(line => /^\|/.test(line) && line.includes("`/dashboard`"));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toMatch(/^\| (?:🔒 )?`\/web` \(`\/dashboard`(?: alias| 別名)?\) \|/);
  });
});
