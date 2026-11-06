/**
 * #3270: `agend web` opens the sign-in page as /signin#code=XXXX-XXXX on this computer. The page's own script (src/ui/shared/signin.js,
 * in a vm) clears the fragment before it makes any request, and exchanges the code only on a loopback host name; a wrong
 * or used code falls back to the form with the reason. The CLI's URL assembly is tested here too.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { mkdtempSync, readFileSync as readFile, rmSync, statSync, utimesSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { describeCodeLifetime, isWsl, launchFileArgument, signinLaunchHtml, sweepSigninLaunchFiles, webSigninLinks, writeSigninLaunchFile } from "../src/web-signin-link.js";

const SRC = readFileSync(join(process.cwd(), "src", "ui", "shared", "signin.js"), "utf8");

interface Opts { hostname: string; hash: string; search?: string; login?: number | "throw"; session?: boolean; navType?: string }

async function load(o: Opts) {
  const events: string[] = [];
  const logins: unknown[] = [];
  const replaced: string[] = [];
  const els: Record<string, { hidden: boolean; textContent: string; value: string; disabled: boolean }> = {};
  const el = (id: string) => (els[id] ??= { hidden: id !== "checking", textContent: "", value: "", disabled: false });
  const node = (id: string) => ({ ...el(id), get hidden() { return el(id).hidden; }, set hidden(v: boolean) { el(id).hidden = v; },
    get textContent() { return el(id).textContent; }, set textContent(v: string) { el(id).textContent = v; },
    get value() { return el(id).value; }, set value(v: string) { el(id).value = v; },
    get disabled() { return el(id).disabled; }, set disabled(v: boolean) { el(id).disabled = v; },
    classList: { add() {}, remove() {} }, addEventListener() {}, focus() {}, select() {}, setAttribute() {} });
  const location = { href: `http://${o.hostname}:1/signin${o.search ?? ""}${o.hash}`, hostname: o.hostname, pathname: "/signin", search: o.search ?? "", hash: o.hash,
    origin: `http://${o.hostname}:1`, replace: (u: string) => { replaced.push(u); events.push(`replace:${u}`); } };
  const context = createContext({
    document: { documentElement: {}, getElementById: (id: string) => node(id), querySelectorAll: () => [], body: { getAttribute: () => null }, createElement: () => ({ textContent: "" }) },
    location,
    history: { replaceState: (_s: unknown, _t: string, url: string) => { events.push(`replaceState:${url}`); location.hash = ""; location.href = `${location.origin}${url}`; } },
    navigator: { language: "en" }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async (url: string, init?: { body?: string }) => {
      events.push(`fetch:${url}`);
      if (url === "/auth/session") return { ok: o.session === true, status: o.session ? 200 : 401 };
      if (url === "/auth/device") return { ok: true, status: 200, json: async () => ({ returning: false }) };
      if (url === "/auth/login") {
        logins.push(JSON.parse(init!.body!));
        if (o.login === "throw") throw new Error("offline");
        const status = o.login ?? 200;
        return { ok: status < 300, status };
      }
      return { ok: false, status: 404 };
    },
    URL, URLSearchParams, JSON, Date, Number, String, setTimeout, clearTimeout,
    ...(o.navType ? { performance: { getEntriesByType: () => [{ type: o.navType }] } } : {}),
  });
  runInContext(SRC, context);
  for (let n = 0; n < 50; n++) await new Promise(r => setImmediate(r));
  return { events, logins, replaced, els, location };
}

describe("#3270 signin.js: #code= on a loopback host name", () => {
  for (const hostname of ["127.0.0.1", "localhost", "::1", "[::1]"]) {
    it(`${hostname}: the fragment is cleared BEFORE any request, then the code is exchanged and the browser goes on`, async () => {
      const p = await load({ hostname, hash: "#code=ABCD-2345" });
      expect(p.events[0]).toBe("replaceState:/signin");
      expect(p.events.indexOf("replaceState:/signin")).toBeLessThan(p.events.findIndex(e => e.startsWith("fetch:")));
      expect(p.logins).toEqual([{ code: "ABCD-2345" }]);
      expect(p.replaced).toEqual(["/ui"]);
      expect(p.events.indexOf("fetch:/auth/session")).toBeLessThan(p.events.indexOf("fetch:/auth/login"));   // no session yet: asked first
      expect(p.els.form?.hidden).toBe(true);
    });
  }

  it("keeps the query (?next=) while clearing the fragment, and goes to that page", async () => {
    const p = await load({ hostname: "localhost", hash: "#code=ABCD-2345", search: "?next=%2Fui%2Fsettings" });
    expect([p.events[0], p.replaced]).toEqual(["replaceState:/signin?next=%2Fui%2Fsettings", ["/ui/settings"]]);
  });

  it("a code without the dash, in lower case, is still sent", async () => {
    const p = await load({ hostname: "127.0.0.1", hash: "#code=abcd2345" });
    expect(p.logins).toEqual([{ code: "abcd2345" }]);
  });

  for (const [what, status, text] of [
    ["expired or used (401)", 401, "The automatic sign-in did not work — its code has expired or was already used. Run agend web on the AgEnD computer for a new one."],
    ["paused (429)", 429, "Too many wrong codes — sign-in is paused for a few minutes."],
    ["not confirmed (503)", 503, "Sign-in could not be confirmed. Get a new code and try again; if it keeps failing, contact the operator."],
  ] as const) {
    it(`${what}: the form comes back with the reason, nothing navigates`, async () => {
      const p = await load({ hostname: "127.0.0.1", hash: "#code=ABCD-2345", login: status });
      expect([p.els.form?.hidden, p.els.checking?.hidden, p.els.msg?.textContent, p.replaced]).toEqual([false, true, text, []]);
    });
  }

  it("a network failure shows the connection message on the form", async () => {
    const p = await load({ hostname: "127.0.0.1", hash: "#code=ABCD-2345", login: "throw" });
    expect([p.els.form?.hidden, p.els.msg?.textContent]).toEqual([false, "Could not reach AgEnD. Check the connection and try again."]);
  });

  it("a failed code is never put back in the box or shown", async () => {
    const p = await load({ hostname: "127.0.0.1", hash: "#code=ABCD-2345", login: 401 });
    expect([p.els.code?.value, JSON.stringify(Object.values(p.els).map(e => e.textContent)).includes("ABCD")]).toEqual(["", false]);
  });

  it("a browser that already has a session is let in WITHOUT exchanging the code over it", async () => {
    const p = await load({ hostname: "127.0.0.1", hash: "#code=ABCD-2345", session: true });
    expect([p.logins, p.replaced, p.events[0]]).toEqual([[], ["/ui"], "replaceState:/signin"]);
  });

  for (const navType of ["reload", "back_forward", "prerender"]) {
    it(`a ${navType} is not a fresh navigation: the fragment is cleared, the code is not exchanged`, async () => {
      const p = await load({ hostname: "127.0.0.1", hash: "#code=ABCD-2345", navType });
      expect([p.events[0], p.logins, p.els.form?.hidden]).toEqual(["replaceState:/signin", [], false]);
    });
  }
  it("a fresh navigation (type navigate) exchanges it", async () => {
    const p = await load({ hostname: "127.0.0.1", hash: "#code=ABCD-2345", navType: "navigate" });
    expect(p.logins).toEqual([{ code: "ABCD-2345" }]);
  });
});

describe("#3270 signin.js: not on a loopback host name", () => {
  for (const hostname of ["agend.example.net", "192.168.1.20", "10.0.0.5", "foo.localhost", "127.0.0.2"]) {
    it(`${hostname}: the fragment is cleared but the code is never sent`, async () => {
      const p = await load({ hostname, hash: "#code=ABCD-2345" });
      expect(p.events[0]).toBe("replaceState:/signin");
      expect(p.logins).toEqual([]);
      expect([p.els.form?.hidden, p.els.msg?.textContent ?? ""]).toEqual([false, ""]);
    });
  }
});

describe("#3270 signin.js: other fragments", () => {
  it("no fragment → the page behaves as before: probe, then the form, no exchange", async () => {
    const p = await load({ hostname: "127.0.0.1", hash: "" });
    expect([p.events.filter(e => e.startsWith("replaceState")), p.logins, p.events.includes("fetch:/auth/session"), p.els.form?.hidden]).toEqual([[], [], true, false]);
  });

  it("a malformed code is cleared and not sent", async () => {
    for (const hash of ["#code=", "#code=short", "#code=ABCD-2345-EXTRA", "#code=AB%00CD2345", "#code=<script>alert(1)</script>"]) {
      const p = await load({ hostname: "127.0.0.1", hash });
      expect([hash, p.events[0], p.logins]).toEqual([hash, "replaceState:/signin", []]);
    }
  });

  it("an unrelated fragment is left alone", async () => {
    const p = await load({ hostname: "127.0.0.1", hash: "#instance=alpha" });
    expect(p.events.filter(e => e.startsWith("replaceState"))).toEqual([]);
  });
});

describe("#3270 agend web: what is printed and what the browser is given", () => {
  it("the printed page is clean; the opened one carries #code=", () => {
    expect(webSigninLinks(19280, "ABCD-2345")).toEqual({ display: "http://localhost:19280/signin", open: "http://localhost:19280/signin#code=ABCD-2345" });
    expect(webSigninLinks(19280, "ABCD-2345", "checklist")).toEqual({ display: "http://localhost:19280/signin?next=checklist", open: "http://localhost:19280/signin?next=checklist#code=ABCD-2345" });
    expect(webSigninLinks(1, "ABCD-2345").display).not.toContain("ABCD");
  });
  it("describes a lifetime as minutes, or hours for a first-install code", () => {
    expect([5 * 60_000, 59 * 60_000, 24 * 3_600_000, 24 * 3_600_000 - 5000].map(describeCodeLifetime)).toEqual(["~5 min", "~59 min", "~24 h", "~24 h"]);
  });
});

describe("#3270 agend web: the launch file keeps the code out of every command line", () => {
  const withHome = (fn: (home: string) => void) => { const home = mkdtempSync(join(tmpdir(), "agend-launch-")); try { fn(home); } finally { rmSync(home, { recursive: true, force: true }); } };

  it("is a 0600 file in a 0700 directory that sends the browser on to the #code= address", () => withHome(home => {
    const target = "http://localhost:19280/signin#code=ABCD-2345";
    const path = writeSigninLaunchFile(home, target);
    expect(path.startsWith(join(home, "signin-launch", "agend-signin-"))).toBe(true);
    expect(path.endsWith(".html")).toBe(true);
    if (process.platform !== "win32") {
      expect((statSync(path).mode & 0o777).toString(8)).toBe("600");
      expect((statSync(join(home, "signin-launch")).mode & 0o777).toString(8)).toBe("700");
    }
    const html = readFile(path, "utf8");
    expect(html).toContain(`location.replace(${JSON.stringify(target)})`);
    expect(html).toContain(`http-equiv="refresh" content="0;url=${target}"`);
  }));

  it("what the opener is given is only the path: a file:// URL (the path itself on Windows) with no code in it", () => withHome(home => {
    const path = writeSigninLaunchFile(home, "http://localhost:19280/signin#code=ABCD-2345");
    for (const argument of [launchFileArgument(path, "linux"), launchFileArgument(path, "darwin"), launchFileArgument(path, "win32")]) {
      expect(argument).not.toContain("code=");
      expect(argument).not.toContain("#");
    }
    expect(launchFileArgument(path, "linux")).toMatch(/^file:\/\/\//);
    expect(launchFileArgument("C:\\Users\\a\\agend-signin-x.html", "win32")).toBe("C:\\Users\\a\\agend-signin-x.html");
  }));

  it("two launches never share a file", () => withHome(home => {
    expect(writeSigninLaunchFile(home, "http://localhost:1/signin#code=AAAA-2222")).not.toBe(writeSigninLaunchFile(home, "http://localhost:1/signin#code=AAAA-2222"));
  }));

  it("the next run sweeps launch files a crash left behind — only old ones, only ours", () => withHome(home => {
    const old = writeSigninLaunchFile(home, "http://localhost:1/signin#code=AAAA-2222");
    const fresh = writeSigninLaunchFile(home, "http://localhost:1/signin#code=BBBB-3333");
    const other = join(home, "signin-launch", "keep.txt");
    writeFileSync(other, "x");
    utimesSync(old, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    utimesSync(other, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    expect(sweepSigninLaunchFiles(home, Date.now())).toBe(1);
    expect([existsSync(old), existsSync(fresh), existsSync(other)]).toEqual([false, true, true]);
    expect(readdirSync(join(home, "signin-launch")).length).toBe(2);
    expect(sweepSigninLaunchFiles(join(home, "none"), Date.now())).toBe(0);    // no directory: nothing, no throw
  }));

  it("the page cannot be broken out of by what is in the address", () => {
    const html = signinLaunchHtml('http://localhost:1/signin?next="></script><script>alert(1)</script>#code=A');
    expect(html.match(/<script>/g)?.length).toBe(1);
    expect(html).not.toContain("</script><script>");
    expect(html).toContain("&quot;");
  });

  it("WSL is recognised from the environment or /proc/version; then agend web opens the clean address", () => {
    expect(isWsl({ AGEND_WSL: "0", WSL_DISTRO_NAME: "Ubuntu" }, () => "microsoft")).toBe(false);
    expect([isWsl({ WSL_DISTRO_NAME: "Ubuntu" }, () => ""), isWsl({}, () => "Linux version 6.6 microsoft-standard-WSL2"), isWsl({}, () => "Linux version 6.8 generic"), isWsl({}, () => { throw new Error("none"); })])
      .toEqual([true, true, false, false]);
  });
});
