/**
 * #2662 smoke: an Office share link on All offices, six offices each in a full skin pack (160 pictures: the clinic
 * fixture's real PNGs under distinct ids), in a real browser — the share gateway on loopback (no tunnel: the server
 * wrapper presents the tunnel's Host). Phase 1: two viewers open the link at once; every picture each page asks for
 * answers 200 (no 429), and only the character sets the people shown wear are asked for. Phase 2: the share's minute
 * of pictures already spent (as if by other viewers 50 s ago): the page is refused (429), waits out Retry-After and
 * fills in — every picture it asked for ends with a 200. Shots: all-offices (phase 1), refilled (phase 2).
 *
 *   PW_DIR=<dir with playwright-core> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx tsx scripts/manual/smoke/smoke-2662-share-pictures.mts
 */
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { ALL_OFFICES, OfficeShareLimiter, OfficeShares, createOfficeShareGateway, sharePictureRate, type OfficeShareSource } from "../../../src/office-share.js";
import { OFFICE_SHARE_PAGE, OFFICE_SHARE_PAGE_CSP, officeShareStatic } from "../../../src/office-share-page.js";

const PW = process.env.PW_DIR, OUT = process.env.OUT ?? "/tmp/smoke-2662";
if (!PW) throw new Error("set PW_DIR");
mkdirSync(OUT, { recursive: true });
const HOST = "abc-office.trycloudflare.com";
const FIX = join(process.cwd(), "tests", "fixtures", "office-skin-clinic");
const BG = readFileSync(join(FIX, "office_bg.png")), FOX = readFileSync(join(FIX, "fox_idle.png"));
const BASE_MANIFEST = JSON.parse(readFileSync(join(FIX, "manifest.json"), "utf8"));
const POSES = ["idle", "working", "paused", "needs", "walk"];
const people = ["atlas", "quill", "sage", "nova", "tide", "orbit", "pixel", "ember"];
const idle = BASE_MANIFEST.characters.default.idle;

const packs = Array.from({ length: 6 }, (_, n) => {
  const id = `full${n}`;
  const characters: Record<string, Record<string, unknown>> = { default: Object.fromEntries(POSES.slice(0, 4).map(p => [p, { ...idle, src: `default_${p}.png` }])) };
  for (let s = 0; s < 31; s++) characters[`set${s}`] = Object.fromEntries(POSES.map(p => [p, { ...idle, src: `set${s}/${p}.png` }]));
  const byInstance = Object.fromEntries([...people, "elsewhere-1", "elsewhere-2"].map((name, i) => [name, `set${i}`]));
  const manifest = { ...BASE_MANIFEST, id, background: `${id}_bg.png`, characters, byInstance };
  const srcs: string[] = [manifest.background, ...Object.values(characters).flatMap(set => Object.values(set).map(st => (st as { src: string }).src))];
  const files = Object.fromEntries(srcs.map((src, i) => [src, `${n.toString(16).padStart(2, "0")}${i.toString(16).padStart(30, "0")}`]));
  const bytes = BG.length + (srcs.length - 1) * FOX.length;
  return { id, name: `Full ${n}`, sha: `${n.toString(16).padStart(2, "0")}${"5".repeat(30)}`, manifest, files, bytes, bg: files[manifest.background] };
});
const source: OfficeShareSource = {
  status: () => ({ instances: people.map((name, k) => ({ name, display_name: name[0]!.toUpperCase() + name.slice(1), backend: "claude-code", status: "running", execution_state: k % 2 ? "idle" : "working" })) }),
  org: () => ({ general: [], teams: [{ name: "Core", members: people }], instances: {} }),
  offices: () => ({ rev: 1, offices: packs.map((pk, i) => ({ id: `o${i}`, name: `Room ${i + 1}`, skin: pk.id, members: people.slice(i % 4, i % 4 + 4) })) }),
  acts: () => [], traffic: () => ({ now: new Date().toISOString(), items: [], delegations: [] }), needs: () => [], hidden: () => false,
  skins: {
    list: () => ({ rev: "r", packs: packs.map(pk => ({ id: pk.id, name: pk.name, sha: pk.sha, bytes: pk.bytes, files: Object.keys(pk.files).length, uploaded_at: 0 })) }),
    get: id => { const pk = packs.find(p => p.id === id); return pk ? { id: pk.id, name: pk.name, sha: pk.sha, manifest: JSON.parse(JSON.stringify(pk.manifest)), files: { ...pk.files } } : null; },
    picture: (id, sha) => { const pk = packs.find(p => p.id === id); return pk && Object.values(pk.files).includes(sha) ? (sha === pk.bg ? BG : FOX) : null; },
  },
};
let shift = 0;
const pictureLimiter = new OfficeShareLimiter(() => performance.now() + shift);
const shares = new OfficeShares();
const made = shares.create({ office: ALL_OFFICES, owner: "smoke", exists: () => true });
if (!made.ok) throw new Error(made.error);
const gw = createOfficeShareGateway({
  shares, source, pictureLimiter, page: () => ({ body: OFFICE_SHARE_PAGE, csp: OFFICE_SHARE_PAGE_CSP }), statics: officeShareStatic,
  create: (handler => createServer((req, res) => { req.headers.host = HOST; (handler as (a: typeof req, b: typeof res) => void)(req, res); })) as typeof createServer,
});
const base = await gw.listen();
gw.setHost(HOST);
const linkOf = (token: string) => `${base.origin}/o/${token}`;

const pw = createRequire(PW + "/")("playwright-core");
const browser = await pw.chromium.launch({ args: ["--no-sandbox"] });
const problems: string[] = [], report: Record<string, unknown> = {};
type Seen = Map<string, number[]>;
async function open(name: string, url: string) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light", locale: "en-US", deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const seen: Seen = new Map();
  page.on("response", (r: { url(): string; status(): number }) => {
    const p = new URL(r.url()).pathname;
    if (p.includes("/img/")) seen.set(p, [...(seen.get(p) ?? []), r.status()]);
  });
  page.on("pageerror", (e: Error) => problems.push(`${name}: ${e.message}`));
  page.on("console", (m: { type(): string; text(): string }) => { if (m.type() === "error" && !/status of 429/.test(m.text())) problems.push(`${name}: ${m.text()}`); });
  await page.goto(url);
  await page.waitForSelector(".oo-canvas", { timeout: 15000 });
  return { ctx, page, seen };
}
const settled = async (seen: Seen, ms: number) => {
  const until = Date.now() + ms;
  let last = -1;
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, 1500));
    const n = [...seen.values()].reduce((a, s) => a + s.length, 0);
    const done = seen.size > 0 && [...seen.values()].every(s => s.at(-1) === 200);
    if (done && n === last) return true;
    last = n;
  }
  return false;
};
const worn = 1 + 4 + 5 * people.length;                              // background, default's 4 poses, the sets worn
// Phase 1: two viewers at once.
const [a, b] = await Promise.all([open("viewer-a", linkOf(made.token)), open("viewer-b", linkOf(made.token))]);
for (const [name, v] of [["viewer-a", a], ["viewer-b", b]] as const) {
  const ok = await settled(v.seen, 30000);
  const statuses = [...v.seen.values()].flat();
  report[name] = { pictures: v.seen.size, perPack: Math.round(v.seen.size / packs.length), refused: statuses.filter(s => s === 429).length, allLoaded: ok };
  if (!ok) problems.push(`${name}: not every picture answered 200`);
  if (statuses.some(s => s === 429)) problems.push(`${name}: a 429 with the share's minute unspent`);
  if (v.seen.size > packs.length * worn) problems.push(`${name}: asked ${v.seen.size} pictures, more than the ${packs.length * worn} worn`);
}
await a.page.waitForTimeout(1500);
await a.page.screenshot({ path: join(OUT, "all-offices.png") });
await a.ctx.close(); await b.ctx.close();
// Phase 2: another link, its minute of pictures spent 50 s ago; a new viewer waits it out.
const second = shares.create({ office: ALL_OFFICES, owner: "smoke", exists: () => true });
if (!second.ok) throw new Error(second.error);
const rate = sharePictureRate(second.share, source.offices().offices, source.skins!.list().packs);
shift = -50_000;
for (let i = 0; i < rate.requests; i++) pictureLimiter.admit(second.share.id, rate);
shift = 0;
const started = Date.now();
const c = await open("viewer-c", linkOf(second.token));
const ok = await settled(c.seen, 45000);
const statuses = [...c.seen.values()].flat();
report["viewer-c"] = { pictures: c.seen.size, refused: statuses.filter(s => s === 429).length, allLoaded: ok, seconds: Math.round((Date.now() - started) / 1000) };
if (!statuses.includes(429)) problems.push("viewer-c: never refused (the spent minute was not seen)");
if (!ok) problems.push("viewer-c: not every picture filled in after the wait");
await c.page.waitForTimeout(1500);
await c.page.screenshot({ path: join(OUT, "refilled.png") });
await c.ctx.close();
await browser.close();
gw.close();
console.log(JSON.stringify({ shots: OUT, rate, report, problems }, null, 1));
process.exit(problems.length ? 1 : 0);
