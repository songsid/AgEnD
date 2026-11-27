/**
 * M-3827 real-app captures (owned web fixture; no Fleet/CLI starts, no Discord, no network): an agent's message that
 * mentions two people who spoke before a fleet restart and not since.
 *   before (the tree without M-3827): the people seen live only in memory, so after the restart the pills read @user.
 *   after (this tree): the people seen are kept in <home>/web-seen-users.json and loaded at start, so the pills keep
 *   their names.
 * The restart, at the one state it touches: the fleet's start loads the file (startAll's own call), the people speak
 * (the record handleInboundMessage makes), the stop writes what is owed (stop()'s flush), and the new process starts
 * with an empty list in memory and loads the file again. The page, /ui/mentions and the chat are the real ones.
 * Desk light en and phone dark zh-TW.
 *   PW_DIR=<playwright-core> REPO=<checkout> OUT=<dir> [HP=<port>] npx tsx scripts/manual/mention-names-restart-m3827/capture.mts
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix } from "../smoke-fixture/index.mts";

const OUT = process.env.OUT!, REPO = process.env.REPO!;
mkdirSync(OUT, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, "-c", "gc.auto=0", ...a], { encoding: "utf8" }).trim();
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", "src").split("\n").filter(Boolean), checks: [], pictures: [] };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`); };

const PERSON_A = "100000000000000001", PERSON_B = "100000000000000002";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48627), classic: false, host: true,
  roster: [
    { name: "general", general: true, backend: "claude-code", displayName: "General", status: "running" },
    { name: "dev", backend: "claude-code", displayName: "Example helper", status: "running" },
  ] });
const fm = fx.fm;
const { SeenUsers } = await import(REPO + "/src/web-mentions.ts");
const kept = typeof SeenUsers.prototype.persistTo === "function";
receipt.tree = kept ? "after (M-3827)" : "before";
const file = join(fx.dir, "web-seen-users.json");
const load = () => { if (kept) fm.seenUsers.persistTo({ path: file }); };

// Before the restart: the fleet starts, two people speak on Discord, the fleet stops.
load();
fm.seenUsers.record(PERSON_A, "Avery Example");
fm.seenUsers.record(PERSON_B, "小安");
fm.seenUsers.flush?.();
check("the people seen are on disk only with M-3827", existsSync(file) === kept, { kept, exists: existsSync(file) });
// The restart: a new process starts with nothing in memory, then (with M-3827) loads the file.
fm.seenUsers = new SeenUsers();
load();
fm.emitSseEvent("message", { instance: "dev", sender: "dev", role: "agent", text: `<@${PERSON_A}> <@${PERSON_B}> the weekly report is ready for review.`, ts: new Date().toISOString() });

const want = kept ? ["@Avery Example", "@小安"] : ["@user", "@user"];
for (const c of matrix().filter((c: any) => (c.device === "desk" && c.theme === "light" && c.lang === "en") || (c.device === "phone" && c.theme === "dark" && c.lang === "zh-TW"))) {
  const tag = caseName(c);
  const { page, ctx } = await fx.page(c, { path: "/ui/chat/dev" });
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
  try {
    await page.waitForSelector(".msg.agent .md", { timeout: 20000 });
    // The names come from /ui/mentions after the first draw: wait for the answer, then for the redraw.
    await page.waitForResponse((r: any) => r.url().includes("/ui/mentions"), { timeout: 10000 }).catch(() => null);
    await page.waitForTimeout(600);
    const text: string = await page.evaluate(`[...document.querySelectorAll(".msg.agent .md")].map(e => e.innerText).find(t => t.includes("weekly report")) || ""`);
    check(`${tag}: the pills read ${want.join(" ")}`, want.every((w) => text.includes(w)) && (kept ? !text.includes("@user") : true), text);
    check(`${tag}: no page errors`, errors.length === 0, errors);
    await page.evaluate(`[...document.querySelectorAll(".msg.agent")].find(e => e.innerText.includes("weekly report"))?.scrollIntoView({ block: "center" })`);
    await page.waitForTimeout(400);
    const path = `m3827-${kept ? "after" : "before"}-${tag}.png`;
    await page.screenshot({ path: join(OUT, path) });
    receipt.pictures.push({ path, sha256: createHash("sha256").update(readFileSync(join(OUT, path))).digest("hex") });
  } finally { await ctx.close(); }
}
const failed = receipt.checks.filter((c: any) => !c.ok).length;
receipt.summary = `${receipt.checks.length - failed}/${receipt.checks.length}`;
writeFileSync(join(OUT, `receipt-${kept ? "after" : "before"}.json`), JSON.stringify(receipt, null, 2) + "\n");
console.log(`${receipt.tree}: ${receipt.summary} at ${receipt.sourceHead}${receipt.dirty.length ? " (src dirty)" : ""}`);
await fx.close();
process.exit(failed ? 1 : 0);
