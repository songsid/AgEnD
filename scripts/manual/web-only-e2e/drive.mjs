// #2910 web-only e2e driver (inside the container, as rh, once run.sh started the fleet). A channel-less fleet — lead and
// worker (real Claude Code; lead asks before acting), coder (real Codex; asks before acting) — against mock model APIs.
// The journey a web-only person takes, each step through the dashboard's own routes:
//   0. the sign-in page leads with `agend web --code`; signed in with it from this computer: this computer's admin;
//   1. New agent from the web: applied by the browser itself (no host confirm), running, no topic;
//   2. a schedule made from the web fires and reaches lead;
//   3. agents message each other (lead → worker);
//   4. a Notice: worker's CLI killed → its crash is in Notices (pushed, listed, unread);
//   5. Claude Code's own permission dialog, answered from the web: Yes runs the command, No does not;
//   6. Codex's own approval dialog, answered from the web: Yes runs the command, No does not.
import { request } from "node:http";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const PORT = 19391, BASE = `http://127.0.0.1:${PORT}`, HOME = process.env.HOME, CLI = "/opt/app/dist/cli.js";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let token = "";
for (let i = 0; i < 120 && !token; i++) { try { token = readFileSync(`${HOME}/.agend/web.token`, "utf8").trim(); } catch { await sleep(1000); } }
function http(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ hostname: "127.0.0.1", port: PORT, path, method,
      headers: { ...(data !== undefined ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}), ...headers } },
      (res) => { let d = ""; res.on("data", (c) => d += c).on("end", () => { let j = null; try { j = JSON.parse(d); } catch {} resolve({ status: res.statusCode, headers: res.headers, body: j, raw: d }); }); });
    req.on("error", reject); req.end(data);
  });
}
const T = { "X-Agend-Token": token };
const lines = (file) => { try { return readFileSync(file, "utf8").split("\n").filter(Boolean); } catch { return []; } };
const anthropic = () => lines("/tmp/mock-anthropic.log").map((l) => JSON.parse(l));
const codexBodies = () => lines("/tmp/mock-codex-bodies.log");
const pane = (name) => { try { return execSync(`tmux capture-pane -p -t agend:${name}`, { encoding: "utf8" }); } catch { return ""; } };
const checks = []; let pass = true;
const check = (name, ok, detail = "") => { checks.push(`| ${name} | ${ok ? "PASS" : "FAIL"} | ${String(detail).replace(/\|/g, "/").replace(/\s+/g, " ").slice(0, 300)} |`); pass &&= !!ok; };
async function until(fn, ms, step = 1000) { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); } catch { v = null; } if (v) return v; await sleep(step); } return v; }
const running = async (name) => ((await http("GET", "/api/fleet", { headers: T })).body?.instances ?? []).find((i) => i.name === name && i.status === "running") ?? null;
const yamlEntry = (name) => new RegExp(`\\n  ${name}:\\n((?:    .*\\n)+)`).exec(readFileSync(`${HOME}/.agend/fleet.yaml`, "utf8"))?.[1] ?? "";

const up = await until(async () => (await Promise.all(["lead", "worker", "coder"].map(running))).every(Boolean), 240_000, 2000);
check("a channel-less fleet starts: lead, worker (Claude Code), coder (Codex)", !!up);
await sleep(15_000);

// 0. Sign-in.
const signinPage = await http("GET", "/signin");
const out = execFileSync("node", [CLI, "web", "--code"], { encoding: "utf8" });
const login = await http("POST", "/auth/login", { headers: { Origin: BASE, Host: `127.0.0.1:${PORT}` }, body: { code: /Code:\s+(\S+)/.exec(out)?.[1] } });
const cookie = String([].concat(login.headers["set-cookie"] ?? [])[0] ?? "").split(";")[0], csrf = login.body?.csrf;
const S = () => ({ Cookie: cookie, Origin: BASE, "X-Agend-CSRF": csrf, "Idempotency-Key": `k-${randomUUID()}` });
const auth = await http("GET", "/ui/authorization", { headers: S() });
check("0. the sign-in page is marked web-only; `agend web --code` from this computer signs in as this computer's admin (verified)",
  signinPage.body === null && signinPage.raw.includes('<body data-web-only="1">') && login.status === 200 && auth.body?.state === "verified", `${login.status}; ${auth.raw}`);

// 1. New agent.
const create = await http("POST", "/ui/instances", { headers: S(), body: { topic_name: "helper" } });
const pc = create.body?.pending_change;
const helper = await until(() => running("helper"), 120_000, 2000);
const view = pc?.id ? await until(async () => { const v = await http("GET", `/api/settings/pending/${pc.id}`, { headers: S() }); return v.body?.state !== "applying" ? v : null; }, 30_000) : null;
check("1. New agent from the web: applied by the browser itself, running, no topic", create.status === 202 && !!helper && view?.body?.state === "applied" && !!yamlEntry("helper") && !/topic_id/.test(yamlEntry("helper")),
  `${create.status} → ${view?.body?.state} by ${view?.body?.outcome?.decided_by_label ?? "?"}; ${helper ? "running" : "not running"}`);

// 2. A schedule.
const at = new Date(Date.now() + 20_000).toISOString();
const made = await http("POST", "/ui/schedules", { headers: S(), body: { at, message: "PING-2377 #9 (from a schedule)", target: "lead", label: "e2e" } });
const fired = await until(() => anthropic().find((m) => /PING-2377 #9 \(from a schedule\)/.test(m.first + m.last)), 90_000);
check("2. a schedule made from the web fires and reaches lead", made.status === 200 && !!fired, `${made.status}; ${fired ? "lead got it" : "not delivered"}`);

// 3. Cross-instance.
await http("POST", "/ui/send", { headers: S(), body: { instance: "lead", message: "SEND-2910 to worker: hello from lead" } });
const delivered = await until(() => anthropic().find((m) => /\[from:lead\] hello from lead/.test(m.first + m.last)), 90_000);
check("3. lead → worker (send_to_instance) on a web-only fleet", !!delivered, delivered ? "worker got [from:lead] hello from lead" : "not delivered");

// 4. A Notice.
const killed = execSync(`for p in $(pgrep -x claude); do if [ "$(readlink /proc/$p/cwd)" = "${HOME}/w/worker" ]; then kill -9 $p && echo $p; fi; done`, { encoding: "utf8", shell: "/bin/bash" }).trim();
const notice = await until(async () => (await http("GET", "/ui/notices/list", { headers: S() })).body?.items?.find((n) => n.instance === "worker" && n.kind === "instance"), 60_000);
const list = (await http("GET", "/ui/notices/list", { headers: S() })).body;
check("4. worker's CLI killed: its crash is a Notice (listed, unread)", !!killed && !!notice && list?.unread > 0, `${notice?.text ?? "no notice"} (unread ${list?.unread})`);
await until(() => running("worker"), 90_000, 2000);

// The open card for an instance whose text matches.
const cardFor = async (instance, re) => ((await http("GET", "/ui/prompts", { headers: S() })).body?.prompts ?? []).find((p) => p.instance === instance && re.test(p.text));
async function answer(instance, re, pick) {
  const card = await until(() => cardFor(instance, re), 120_000, 2000);
  const action = card ? pick(card.actions) : null;
  const r = action ? await http("POST", "/ui/prompt", { headers: S(), body: { instance, nonce: card.nonce, action: action.id } }) : null;
  const gone = card ? await until(async () => !(await cardFor(instance, re)), 30_000) : false;
  return { card, action, status: r?.status, gone };
}
const yes = (actions) => actions.find((a) => /^1\. Yes/.test(a.label));
const no = (actions) => actions.find((a) => /\. No\b/.test(a.label));

// 5. Claude Code's permission dialog.
await http("POST", "/ui/send", { headers: S(), body: { instance: "lead", message: "PERM-2910 yes-one.txt" } });
const c1 = await answer("lead", /touch \/home\/rh\/w\/lead\/yes-one\.txt/, yes);
const ran1 = await until(() => existsSync(`${HOME}/w/lead/yes-one.txt`), 30_000);
await sleep(5_000);
await http("POST", "/ui/send", { headers: S(), body: { instance: "lead", message: "PERM-2910 no-two.txt" } });
const c2 = await answer("lead", /touch \/home\/rh\/w\/lead\/no-two\.txt/, no);
await sleep(8_000);
check("5. Claude Code's own permission dialog from the web: its words and options, no Skip; Yes ran it, No did not",
  !!c1.card && !c1.card.actions.some((a) => a.id === "skip") && c1.status === 200 && !!ran1 && !!c1.gone && c2.status === 200 && !!c2.gone && !existsSync(`${HOME}/w/lead/no-two.txt`),
  `buttons: ${(c1.card?.actions ?? []).map((a) => a.label).join(" | ")}; yes ${c1.status} file ${ran1 ? "made" : "absent"}; no ${c2.status} (${c2.action?.label}) file ${existsSync(`${HOME}/w/lead/no-two.txt`) ? "MADE" : "absent"}`);

// 6. Codex's approval dialog (the mock's `approval` turn: `echo probe`, asking for escalation).
const before = codexBodies().length;
await http("POST", "/ui/send", { headers: S(), body: { instance: "coder", message: "run the probe" } });
const x1 = await answer("coder", /echo probe/, yes);
const ran = await until(() => codexBodies().slice(before).find((b) => /function_call_output/.test(b) && /probe/.test(b.slice(b.indexOf("function_call_output")))), 60_000);
await sleep(5_000);
const mid = codexBodies().length;
await http("POST", "/ui/send", { headers: S(), body: { instance: "coder", message: "run the probe again" } });
const x2 = await answer("coder", /echo probe/, no);
await sleep(10_000);
const after = codexBodies().slice(mid).filter((b) => /function_call_output/.test(b));
const after2 = pane("coder").split("\n").filter((l) => l.trim()).slice(-12).join(" ⏎ ");
check("6. Codex's own approval dialog from the web: its options, no Skip; Yes ran the command, No did not",
  !!x1.card && !x1.card.actions.some((a) => a.id === "skip") && x1.status === 200 && !!ran && !!x1.gone && x2.status === 200 && !!x2.gone
    && !after.some((b) => /"output":"probe|probe\\n/.test(b)),
  `card: ${(x1.card?.text ?? "none").split("\n").slice(0, 4).join(" ⏎ ")} / buttons: ${(x1.card?.actions ?? []).map((a) => a.label).join(" | ")}; yes ${x1.status} ran ${ran ? "yes" : "no"}; no ${x2.status} (${x2.action?.label}); pane: ${after2.slice(-160)}`);

console.log(`label: ${process.env.LABEL}\n\n| check | result | detail |\n|---|---|---|\n` + checks.join("\n"));
console.log(`\nRESULT ${pass ? "PASS" : "FAIL"}`);
