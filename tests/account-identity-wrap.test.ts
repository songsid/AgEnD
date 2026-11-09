import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A whole e-mail is long (up to 254 characters; 60 is common enough). The Accounts row shows it in a `.tag` pill, and the shared `.tag` is `white-space: nowrap`,
 * which defeats `overflow-wrap: anywhere` and pushes the row past a phone's width. The identity pill has to override that with a selector that does not depend on
 * which stylesheet loads last, and nothing else that shows the address may keep the pill's `nowrap`.
 */
const read = (path: string) => readFileSync(new URL(`../src/ui/shared/${path}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rules = (css: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ selector: m[1].trim(), body: m[2] }));
const classes = (selector: string) => (selector.match(/\.[A-Za-z_-][\w-]*/g) ?? []).length;

describe("a long e-mail wraps inside the Accounts row", () => {
  const accounts = rules(read("accounts.css")), app = rules(read("app.css")), runtime = rules(read("runtime-install.css"));
  it("the shared `.tag` is nowrap (the thing that has to be overridden)", () => {
    expect(app.find(rule => rule.selector === ".tag")?.body).toMatch(/white-space:\s*nowrap/);
  });
  it("the identity pill sets white-space: normal with MORE specificity than `.tag`, so the load order of the two sheets cannot bring nowrap back", () => {
    const own = accounts.filter(rule => /s-account-identity/.test(rule.selector) && /white-space:\s*normal/.test(rule.body));
    expect(own.length).toBeGreaterThan(0);
    for (const rule of own) expect(classes(rule.selector), rule.selector).toBeGreaterThan(classes(".tag"));
    const all = accounts.filter(rule => /s-account-identity/.test(rule.selector)).map(rule => rule.body).join(";");
    expect(all).toMatch(/overflow-wrap:\s*anywhere/); expect(all).toMatch(/min-width:\s*0/); expect(all).toMatch(/max-width:\s*100%/);
  });
  it("no other place that shows an account's address is nowrap", () => {
    for (const rule of [...accounts, ...runtime]) if (/s-account-identity|runtime-account|s-host-cli-account/.test(rule.selector)) expect(rule.body, rule.selector).not.toMatch(/white-space:\s*(nowrap|pre)/);
  });
});
