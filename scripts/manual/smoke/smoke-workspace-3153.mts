// #3153 P1 acceptance: an agent's read-only Files & changes panel, on the realistic fixture (never `fleet start`), against
// a REAL working directory — a git repo made here with every case the acceptance names: a modified file, an untracked
// one, a binary, a symlink escaping the folder (file and directory), `.env` and a private key, a big diff, a gitignored
// build output, an image.
// - desk light (en) and phone dark (zh-TW): the chat's ⋯ → "Files & changes" → Changes (the default: statuses, counts,
//   why a diff is not shown, a diff opened) → Files (the tree; a text file with line numbers; the image inline).
// - Nothing secret ever reaches the browser: every /ui/workspace answer is checked for the secrets' text and for the
//   escaping symlinks' target. No page error, no CSP report, no page-level horizontal scroll.
// - the stale-tab skew (rule 3): the old shell (every /assets file from OLD_REF) with this branch's chat modules — the
//   entry and the panel work; this shell with the old chat modules (OLD_REF) — no entry, nothing broken.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> [OLD_REF=origin/release/2.3.5-alpha] FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-workspace-3153.mts
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-workspace-3153";
const REPO = process.env.REPO!, OLD_REF = process.env.OLD_REF ?? "origin/release/2.3.5-alpha";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48680), instances: 2 });
const fm = fx.fm as any;
const name = fx.instances.find((i: any) => !i.general)!.name;

// ── the agent's real working directory ──
const work = join(fx.dir, "agent-work"), outside = join(fx.dir, "outside");
mkdirSync(work); mkdirSync(outside);
writeFileSync(join(outside, "secret.txt"), "OUTSIDE-SECRET-3153");
const git = (...a: string[]) => execFileSync("git", ["-C", work, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" } });
git("init", "-q", "-b", "main");
writeFileSync(join(work, "app.js"), "export function total(items) {\n  return items.length;\n}\n");
writeFileSync(join(work, ".gitignore"), "build/\n");
writeFileSync(join(work, "big.txt"), "start\n");
mkdirSync(join(work, "src")); writeFileSync(join(work, "src", "util.ts"), "export const x = 1;\n");
git("add", "."); git("commit", "-q", "-m", "init");
writeFileSync(join(work, "app.js"), "export function total(items) {\n  // count only the paid ones\n  return items.filter((i) => i.paid).length;\n}\n");
writeFileSync(join(work, "NOTES.md"), "# Notes\n\n- new untracked file\n");
writeFileSync(join(work, "data.bin"), Buffer.from([0, 1, 2, 0, 255, 0]));
writeFileSync(join(work, "big.txt"), Array.from({ length: 120_000 }, (_, i) => `row ${i}`).join("\n"));
writeFileSync(join(work, ".env"), "API_KEY=ENV-SECRET-3153\n");
writeFileSync(join(work, "deploy.key"), "-----BEGIN PRIVATE KEY----- KEY-SECRET-3153\n");
symlinkSync(join(outside, "secret.txt"), join(work, "escape.txt"));
symlinkSync(outside, join(work, "escape-dir"));
mkdirSync(join(work, "build")); writeFileSync(join(work, "build", "out.js"), "ignored");
// A 2×2 PNG (red), an image the viewer shows inline.
writeFileSync(join(work, "logo.png"), Buffer.from("89504e470d0a1a0a0000000d4948445200000002000000020802000000fdd49a730000001649444154789c63f8cfc0f09f81818101c8000062fc0bf599b0b4c90000000049454e44ae426082", "hex"));
fm.fleetConfig.instances[name].working_directory = work;
const SECRETS = ["ENV-SECRET-3153", "KEY-SECRET-3153", "OUTSIDE-SECRET-3153"];

const r: Record<string, unknown> = { browser: fx.browser.version(), oldRef: OLD_REF, instance: name };
const fail: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => { r[n] = ok ? "PASS" : { FAIL: d ?? true }; if (!ok) fail.push(n); };
const old = (path: string): string | null => { try { return execFileSync("git", ["-C", REPO, "show", `${OLD_REF}:src/ui/${path}`], { encoding: "utf8", maxBuffer: 16 << 20 }); } catch { return null; } };
const CASES = [{ device: "desk", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const;
const LABEL = { en: "Files & changes", "zh-TW": "檔案與變更" } as const;

async function open(c: (typeof CASES)[number], route?: (page: any) => Promise<void>) {
  const { ctx, page, csp } = await fx.page(c as any, { path: `/ui/chat/${encodeURIComponent(name)}` });
  const errs: string[] = [], answers: string[] = [];
  page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
  page.on("response", async (res: any) => { if (res.url().includes("/ui/workspace")) { try { answers.push((await res.body()).toString("utf8")); } catch { /* aborted */ } } });
  if (route) { await route(page); await page.reload(); }
  await page.waitForSelector(".p-chat", { timeout: 15000 });
  return { ctx, page, csp, errs, answers };
}
/** The chat's ⋯ menu → the entry with this label (true if it was there). */
async function entry(page: any, label: string): Promise<boolean> {
  await page.evaluate(`(() => { const b = [...document.querySelectorAll(".p-chat .panel-head button")].find((x) => x.getAttribute("aria-label") === "More actions" || x.getAttribute("aria-label") === "更多動作"); if (b) b.click(); })()`);
  await page.waitForTimeout(400);
  const found = await page.evaluate(`(() => { const i = [...document.querySelectorAll(".menu-item")].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (i) { i.click(); return true; } return false; })()`);
  await page.waitForTimeout(800);
  return found;
}
const PROBE = `(() => {
  const q = (s) => document.querySelector(s), p = q(".ws-panel"), b = p ? p.getBoundingClientRect() : null;
  return { panel: !!p, summary: q(".ws-summary")?.textContent ?? null,
    rows: [...document.querySelectorAll(".ws-change")].map((x) => [x.querySelector(".ws-path").textContent, x.querySelector(".ws-why")?.textContent ?? ""]),
    diffAdds: [...document.querySelectorAll(".ws-diff .d-add")].map((s) => s.textContent.trim()),
    entries: [...document.querySelectorAll(".ws-entry")].map((x) => [x.querySelector(".ws-name").textContent, x.querySelector("button").disabled]),
    lines: document.querySelectorAll(".ws-text .ws-ln").length, img: q(".ws-image") ? { src: q(".ws-image").getAttribute("src"), w: q(".ws-image").naturalWidth } : null,
    text: document.body.innerText, rect: b ? { x: Math.round(b.x), w: Math.round(b.width) } : null, vw: innerWidth, overflowX: document.documentElement.scrollWidth - innerWidth };
})()`;

try {
  for (const c of CASES) {
    const tag = `${c.device}-${c.theme}-${c.lang}`;
    const o = await open(c);
    const found = await entry(o.page, LABEL[c.lang]);
    const ready = await o.page.waitForSelector(".ws-summary", { timeout: 15000 }).then(() => true, () => false);
    if (!ready) throw new Error(`no Changes summary: found=${found} panel=${await o.page.evaluate(`document.querySelector(".ws-panel")?.innerText?.slice(0, 300) ?? "none"`)} menu=${await o.page.evaluate(`[...document.querySelectorAll(".p-chat .panel-head button")].map((b) => b.getAttribute("aria-label")).join("|")`)} answers=${o.answers.join(" ").slice(0, 300)}`);
    const a = await o.page.evaluate(PROBE);
    await o.page.screenshot({ path: shotPath(SMOKE, tag, "1-changes") });
    await o.page.evaluate(`[...document.querySelectorAll(".ws-change")].find((x) => x.querySelector(".ws-path").textContent === "app.js").querySelector("button").click()`);
    await o.page.waitForTimeout(400);
    const d = await o.page.evaluate(PROBE);
    await o.page.screenshot({ path: shotPath(SMOKE, tag, "2-diff") });
    await o.page.evaluate(`document.querySelectorAll(".ws-panel .seg-inline button")[1].click()`);
    await o.page.waitForSelector(".ws-entry", { timeout: 10000 });
    const f = await o.page.evaluate(PROBE);
    await o.page.screenshot({ path: shotPath(SMOKE, tag, "3-files") });
    await o.page.evaluate(`[...document.querySelectorAll(".ws-entry")].find((x) => x.querySelector(".ws-name").textContent === "app.js").querySelector("button").click()`);
    await o.page.waitForSelector(".ws-text", { timeout: 10000 });
    const v = await o.page.evaluate(PROBE);
    await o.page.screenshot({ path: shotPath(SMOKE, tag, "4-file") });
    await o.page.evaluate(`document.querySelector(".ws-viewer-head button").click()`); await o.page.waitForTimeout(300);
    await o.page.evaluate(`[...document.querySelectorAll(".ws-entry")].find((x) => x.querySelector(".ws-name").textContent === "logo.png").querySelector("button").click()`);
    await o.page.waitForSelector(".ws-image", { timeout: 10000 }); await o.page.waitForTimeout(400);
    const i = await o.page.evaluate(PROBE);
    await o.page.screenshot({ path: shotPath(SMOKE, tag, "5-image") });
    const why = Object.fromEntries(a.rows);
    const leaks = SECRETS.filter((s) => o.answers.some((x) => x.includes(s)) || [a, d, f, v, i].some((p: any) => p.text.includes(s)));
    const sheet = c.device === "phone" ? a.rect && a.rect.x === 0 && a.rect.w === a.vw : a.rect && a.rect.w < a.vw;
    const got = { found, summary: a.summary, rows: a.rows, diffAdds: d.diffAdds, entries: f.entries, lines: v.lines, img: i.img, leaks, errs: o.errs, csp: await o.csp(), overflowX: a.overflowX };
    const entryOf = (n: string) => f.entries.find((e: [string, boolean]) => e[0] === n);
    check(tag, found && a.panel && !!sheet
      && Object.keys(why).sort().join() === [".env", "NOTES.md", "app.js", "big.txt", "data.bin", "deploy.key", "escape-dir", "escape.txt", "logo.png"].sort().join()
      && /secret|機密/.test(why[".env"]!) && /secret|機密/.test(why["deploy.key"]!) && /binary|二進位/.test(why["data.bin"]!) && /large|太大/.test(why["big.txt"]!)
      && d.diffAdds.some((x: string) => x.includes("i.paid")) && !f.entries.some((e: [string, boolean]) => e[0] === "build/")
      && entryOf(".env")?.[1] === true && entryOf("escape.txt")?.[1] === true && entryOf("escape-dir")?.[1] === true && entryOf("src/")?.[1] === false
      && v.lines === 4 && i.img?.w === 2 && leaks.length === 0 && o.errs.length === 0 && (got.csp as string[]).length === 0 && a.overflowX <= 0, got);
    await o.ctx.close();
  }

  // ── the stale-tab skew ──
  const oldShell = async (page: any) => page.route("**/assets/**", (route: any) => {
    const file = new URL(route.request().url()).pathname.replace(/^\/assets\//, "");
    const body = old(`shared/${file}`);
    return body === null ? route.continue() : route.fulfill({ status: 200, contentType: file.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8", body });
  });
  {
    const o = await open(CASES[0], oldShell);
    const found = await entry(o.page, LABEL.en);
    const ok = found && await o.page.waitForSelector(".ws-summary", { timeout: 10000 }).then(() => true, () => false);
    await o.page.screenshot({ path: shotPath(SMOKE, "skew", "old-shell-new-chat") });
    check("skew-old-shell-new-chat", ok && o.errs.length === 0, { found, ok, errs: o.errs });
    await o.ctx.close();
  }
  {
    const LAZY = ["panel-chat.js", "chat-thread.js", "preview-panel.js", "chat-strings.js"];
    const o = await open(CASES[0], async (page: any) => page.route(/\/ui\/js\/(panel-chat|chat-thread|preview-panel|chat-strings)\.js(\?.*)?$/, (route: any) => {
      const file = LAZY.find((x) => route.request().url().includes(`/ui/js/${x}`))!;
      return route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: old(file) ?? "" });
    }));
    const found = await entry(o.page, LABEL.en);
    await o.page.screenshot({ path: shotPath(SMOKE, "skew", "new-shell-old-chat") });
    check("skew-new-shell-old-chat", !found && o.errs.length === 0, { found, errs: o.errs });
    await o.ctx.close();
  }
} catch (e) {
  fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500);
} finally {
  writeFileSync(shotPath(SMOKE, "result", "json").replace(/\.png$/, ".json"), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1));
  console.log(fail.length ? `FAIL: ${fail.join(", ")}` : "ALL PASS");
  await fx.close();
  process.exit(fail.length ? 1 : 0);
}
