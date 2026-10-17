/**
 * Seeding the realistic fixture's content into the in-process fleet, through the stores (the agent tools' rate
 * limiter would refuse a fixture's worth of changes): the person's name, avatars at real sizes, identity cards with
 * text at the caps, identity colours, widgets at their item caps, chat history in zh-TW and English with tables and
 * pictures, usage rows with long plan names; and, opt-in, a long owner stylesheet, a drawing effect and a mod near
 * its caps. Each helper returns what it did, so a smoke can report it.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEXT, type FixtureInstance } from "./data.mts";
import { PICTURES, type PictureSpec } from "./pictures.mts";
import type { Fixture } from "./index.mts";

const REPO = () => process.env.REPO!;

/** The person (owner) name at its cap: 32 graphemes. */
export function seedPerson(fx: Fixture): string {
  const name = TEXT.profileName.slice(0, 32);
  fx.fm.setWebPersonName(undefined, name);
  return name;
}

/** Avatars for the first `count` instances: JPEG and WebP photos, a transparent PNG, a tiny one. Under the 256 KiB cap. */
export async function seedAvatars(fx: Fixture, count = 24): Promise<Record<string, string>> {
  const done: Record<string, string> = {};
  const specs: PictureSpec[] = [PICTURES.avatar, { ...PICTURES.avatar, mime: "image/webp", hue: 330 }, PICTURES.avatarTransparent, PICTURES.avatarTiny, { w: 256, h: 384, hue: 50, label: "直", mime: "image/jpeg" }];
  for (const [i, inst] of fx.instances.slice(0, count).entries()) {
    const bytes = await fx.picture({ ...specs[i % specs.length], seed: i * 7919, hue: (specs[i % specs.length].hue + i * 23) % 360 });
    const r = fx.fm.themeStore.addAsset(inst.name, "avatar", bytes);
    if (!r?.ok) { done[inst.name] = `refused: ${r?.error ?? "?"}`; continue; }
    const t = (fx.fm.themeStore.get(inst.name).theme ?? { v: 1 });
    fx.fm.themeStore.setTheme(inst.name, { ...t, v: 1, avatar: r.id }, "agent");
    done[inst.name] = `${bytes.length} B`;
  }
  return done;
}

/** Identity cards (portrait + banner + tagline/bio at the caps, zh-TW and English) for a few instances. */
export async function seedCards(fx: Fixture, names: string[]): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [i, name] of names.entries()) {
    const P = fx.fm.themeStore.addAsset(name, "portrait", await fx.picture({ ...PICTURES.portrait, seed: i + 1 }));
    const B = fx.fm.themeStore.addAsset(name, "banner", await fx.picture({ ...PICTURES.bannerWide, seed: i + 11, hue: (190 + i * 40) % 360 }));
    const cjk = i % 2 === 0;
    const t = (fx.fm.themeStore.get(name).theme ?? { v: 1 });
    const set = fx.seedTheme(name, { ...t, v: 1, card: { ...(P?.id ? { portrait: P.id } : {}), ...(B?.id ? { banner: B.id } : {}),
      tagline: cjk ? TEXT.taglineCjk : TEXT.taglineLatin, bio: cjk ? TEXT.bioCjk : TEXT.bioLatin } });
    out[name] = { portrait: P?.ok ?? P, banner: B?.ok ?? B, set: set?.ok ?? set };
  }
  return out;
}

/** Identity colours for some instances (#1958), presets and a custom hex, every placement. */
export function seedIdentityColors(fx: Fixture, names: string[]): Record<string, unknown> {
  const colors = ["preset:teal", "preset:pink", "preset:amber", "#3d5afe", "preset:violet", "#00897b"];
  const out: Record<string, unknown> = {};
  names.forEach((name, i) => {
    const t = (fx.fm.themeStore.get(name).theme ?? { v: 1 });
    out[name] = fx.fm.themeStore.setTheme(name, { ...t, v: 1, identity: { color: colors[i % colors.length], show: ["name", "bar", "ring"] } }, "agent")?.ok;
  });
  return out;
}

/** Widgets at their caps: chat_header with 4 items, details with 8, labels at 24 graphemes (zh-TW and English). */
export async function seedWidgets(fx: Fixture, name: string): Promise<Record<string, unknown>> {
  const { checkWidgetSpec, checkWidgetData } = await import(REPO() + "/src/web-widget.ts");
  const cut = (s: string, n: number) => [...s].slice(0, n).join("");
  const header = { v: 1, title: cut("今日進度 Today's progress", 24), items: [
    { key: "done", type: "stat", label: cut(TEXT.widgetLabels[0], 24), unit: "項" },
    { key: "prs", type: "progress", label: cut(TEXT.widgetLabels[1], 24) },
    { key: "p95", type: "text", label: cut(TEXT.widgetLabels[2], 24) },
    { key: "build", type: "badge", label: cut(TEXT.widgetLabels[3], 24), tone: "ok" },
  ] };
  const headerData = { done: 12, prs: 0.8, p95: TEXT.widgetValues[2], build: "#4821 passed" };
  const details = { v: 1, title: cut("部署前檢查清單 Pre-release checklist", 24), items: Array.from({ length: 8 }, (_, i) => (
    i % 3 === 0 ? { key: `s${i}`, type: "stat", label: cut(TEXT.widgetLabels[i % 5], 24) }
      : i % 3 === 1 ? { key: `l${i}`, type: "list", label: cut(TEXT.widgetLabels[i % 5], 24) }
        : { key: `p${i}`, type: "spark", label: cut(TEXT.widgetLabels[i % 5], 24) })) };
  const detailsData = Object.fromEntries(details.items.map((it: any, i) => [it.key,
    it.type === "stat" ? 1000 + i : it.type === "list" ? Array.from({ length: 6 }, (_, j) => cut(`${TEXT.widgetValues[(i + j) % 5]} — 第 ${j + 1} 項`, 60)) : Array.from({ length: 48 }, (_, j) => Math.round(50 + 40 * Math.sin(j / 4)))]));
  const out: Record<string, unknown> = {};
  for (const [slot, spec, data] of [["chat_header", header, headerData], ["details", details, detailsData]] as const) {
    const s = checkWidgetSpec(spec, slot); if (!s.ok) { out[slot] = s; continue; }
    const d = checkWidgetData(data, s.value); if (!d.ok) { out[slot] = d; continue; }
    out[slot] = fx.fm.themeStore.setWidget(name, slot, s.value, d.value, "agent")?.ok ?? "set";
  }
  return out;
}

/** Chat history: `count` messages per instance, agent/user/status, zh-TW and English, tables, code, served photos. */
export async function seedChat(fx: Fixture, names: string[], count = 40): Promise<number> {
  const { publicAttachment } = await import(REPO() + "/src/web-upload.ts");
  let n = 0;
  for (const [k, name] of names.entries()) {
    const photo = join(fx.dir, `photo-${k}.jpg`);
    writeFileSync(photo, await fx.picture({ w: 1280, h: 960, hue: (k * 60) % 360, label: "照片 photo", mime: "image/jpeg", seed: k + 99 }));
    const served = fx.fm.webFiles.registerServed({ path: photo, instance: name, name: `螢幕截圖-${k}-截取畫面 2026-10-17 下午3點.jpg`, mime: "image/jpeg", kind: "photo" });
    for (let i = 0; i < count; i++) {
      const ts = new Date(Date.now() - (count - i) * 90_000).toISOString();
      const role = i % 5 === 4 ? "status" : i % 2 === 0 ? "user" : "agent";
      const text = role === "status" ? `general → ${name}: ${TEXT.description}`
        : role === "user" ? (i % 4 === 0 ? "請幫我整理今天的部署前檢查清單，並標出還沒完成的項目。" : "Can you summarise last night's benchmark run and attach the flame graph?")
          : i % 3 === 0 ? TEXT.chatCjk : TEXT.chatLatin + "\n\n```ts\nexport function normalizeCjk(s: string): string {\n  return s.normalize(\"NFKC\").replace(/\\s+/g, \" \");\n}\n```";
      fx.fm.emitSseEvent("message", { instance: name, sender: role === "user" ? "Han 漢" : name, role, text, ts,
        ...(role === "agent" && i % 7 === 1 && served ? { attachments: [publicAttachment(served)] } : {}) });
      n++;
    }
  }
  return n;
}

/** Usage rows: three Claude profiles and Codex with long plan names, high and low use. */
export async function seedUsage(fx: Fixture): Promise<void> {
  const { setUsageFetcherForTests } = await import(REPO() + "/src/usage/usage-api.ts");
  const soon = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
  setUsageFetcherForTests(async () => ({ fetchedAt: new Date().toISOString(), providers: [
    { id: "claude", name: "Claude", status: "ok", plan: TEXT.planName, metrics: [{ type: "percent", label: "Session", labelI18n: { key: "usage.metric.session" }, used: 91, resetsAt: soon(2), windowMs: 18e6 }, { type: "percent", label: "Weekly", labelI18n: { key: "usage.metric.weekly" }, used: 64, resetsAt: soon(90), windowMs: 6048e5 }] },
    { id: "claude:research-team-long-profile-name", name: "Claude (research-team-long-profile-name)", profile: "research-team-long-profile-name", status: "ok", plan: TEXT.planNameLong, metrics: [{ type: "percent", label: "Session", labelI18n: { key: "usage.metric.session" }, used: 12, resetsAt: soon(4), windowMs: 18e6 }] },
    { id: "codex", name: "Codex", status: "ok", plan: "Pro 5x", metrics: [{ type: "percent", label: "Weekly", labelI18n: { key: "usage.metric.weekly" }, used: 100, resetsAt: soon(120), windowMs: 6048e5 }] },
  ] }));
  fx.fm.getActiveUsageProviderIds = () => null;
}

/** A long, real-looking owner stylesheet close to the 64 KiB cap (opt-in: it restyles every page). */
export function ownerCss(targetBytes = 60 * 1024): string {
  const rules: string[] = ["/* 擁有者樣式 — owner stylesheet for the realistic fixture */", ":root { --owner-accent: #3d5afe; }"];
  let i = 0;
  while (rules.join("\n").length < targetBytes) {
    rules.push(`.msg.agent .md p:nth-of-type(${(i % 9) + 1}) { line-height: ${1.4 + (i % 5) / 20}; letter-spacing: ${(i % 3) / 100}em; } /* 段落 ${i} */`);
    i++;
  }
  return rules.join("\n");
}

/** A drawing effect: snow and petals drifting over the chat (visible on a screenshot). */
export const SNOW_EFFECT = {
  manifest: { v: 1, runtime: "canvas-worker-v1", worker: "worker.js", name: "fixture-snow", title: "飄雪 Snowfall", regions: ["chat"], layer: "front", wants: [],
    params: { density: { type: "number", min: 10, max: 200, default: 80 } } },
  worker: `const c=agend.canvas,g=c.getContext('2d');let n=80,ps=[];const reset=()=>{ps=Array.from({length:n},()=>({x:Math.random()*c.width,y:Math.random()*c.height,r:2+Math.random()*5,v:0.5+Math.random()*1.5,h:Math.random()<0.3?330:210}))};agend.on('env',e=>{if(e&&e.params&&e.params.density)n=e.params.density;reset()});reset();const tick=()=>{g.clearRect(0,0,c.width,c.height);for(const p of ps){p.y+=p.v;p.x+=Math.sin(p.y/30)*0.6;if(p.y>c.height){p.y=-5;p.x=Math.random()*c.width}g.beginPath();g.arc(p.x,p.y,p.r,0,6.283);g.fillStyle=p.h===330?'rgba(255,182,193,0.85)':'rgba(255,255,255,0.9)';g.fill()}};setInterval(tick,33);agend.ready();`,
};

/** Put the snow effect in the fleet's library (owner or agent) and return its id. */
export function addSnowEffect(fx: Fixture, owner: { kind: "human" | "agent"; id: string }): string {
  const files = new Map<string, Uint8Array>([["effect.json", Buffer.from(JSON.stringify(SNOW_EFFECT.manifest))], ["worker.js", Buffer.from(SNOW_EFFECT.worker)]]);
  const st = fx.fm.effectLibrary.stage(files, owner); if (!st.ok) throw Error(`effect stage: ${st.error}`);
  const r = fx.fm.effectLibrary.commit(st.stageId); if (!r.ok) throw Error(`effect commit: ${r.error}`);
  return r.ids[0];
}

/**
 * A mod near its caps: theme (identity, card text, colours) + chat_header widget + 8 effects (two placed in the theme)
 * + padding pictures, to `targetBytes` (default ~7.5 MiB of the 8 MiB cap). Returns the bundle JSON text.
 */
export async function bigMod(fx: Fixture, targetBytes = 7.5 * 1024 * 1024): Promise<string> {
  const file = (b: Buffer | string) => { const buf = typeof b === "string" ? Buffer.from(b) : b; return { sha256: createHash("sha256").update(buf).digest("hex"), b64: buf.toString("base64") }; };
  const files: Record<string, { sha256: string; b64: string }> = {};
  const effects: string[] = [];
  for (let i = 0; i < 8; i++) {
    const dir = `effects/snow-${i}`; effects.push(dir);
    files[`${dir}/effect.json`] = file(JSON.stringify({ ...SNOW_EFFECT.manifest, name: `snow-${i}`, title: `飄雪 Snowfall ${i + 1}` }));
    files[`${dir}/worker.js`] = file(SNOW_EFFECT.worker);
  }
  files["theme.json"] = file(JSON.stringify({ v: 1, accent: "#3d5afe", identity: { color: "preset:teal", show: ["name", "bar", "ring"] },
    effects: [{ effect: effects[0], params: { density: 120 } }, { effect: effects[1], params: { density: 40 } }] }));
  // Bulk: a picture inside each effect (a mod file must be used by a part; an effect is at most 1 MiB), until the target.
  for (let i = 0; i < effects.length && Buffer.byteLength(JSON.stringify(files)) < targetBytes * 1.3; i++)
    files[`${effects[i]}/assets/backdrop.jpg`] = file(await fx.picture({ w: 1280, h: 960, hue: (i * 37) % 360, label: `素材 ${i}`, mime: "image/jpeg", seed: i + 500 }));
  return JSON.stringify({ format: "agend-mod", v: 1, manifest: { name: "realistic-fixture-mod", version: "1.2.3", title: "寫實測試模組 Realistic fixture mod", author: "AgEnD smoke",
    description: "A mod near its size cap, with eight effects (two placed in its theme), each carrying a picture. 測試用，請勿在正式環境安裝。", contents: { theme: "theme.json", effects } }, files });
}

export type { FixtureInstance };
