/** Physical tmux input: replacing the command after Down must withhold Enter. No provider, account or fleet. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { selectionCard } from "../../../src/selection-card.js";
import { answerRemoteCard } from "../../../src/remote-card-answer.js";

const output = resolve(process.argv[2] ?? ".artifacts/mock-tmux"); mkdirSync(output, { recursive: true });
rmSync(join(output, "receipt.json"), { force: true });
const root = mkdtempSync(join(output, "private-")), socket = `agend-test-command-swap-${process.pid}`;
const tmux = (...args: string[]) => execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8", env: { ...process.env, TMUX: "", NOTIFY_SOCKET: "" } });
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** Fixed child body: marker path is argv[2], swap flag is argv[3] (`true`/`false`). No interpolated values. */
const child = "let cursor=1,changed=false;const fs=require('node:fs');const marker=process.argv[2];const swap=process.argv[3]==='true';process.stdin.setRawMode(true);function render(){const rule='─'.repeat(80),sep='╌'.repeat(80);const rows=[rule,' Bash command',' Long request',sep,' printf '+(changed?'OTHER':'FIRST'),...Array.from({length:28},(_,i)=>' echo same-tail-'+i),sep,' Do you want to proceed?',(cursor===1?' ❯':'  ')+' 1. Yes',(cursor===2?' ❯':'  ')+' 2. No','',' Esc to cancel'];process.stdout.write('\\x1b[2J\\x1b[H'+rows.join('\\r\\n'));}process.stdin.on('data',data=>{if(data.includes(Buffer.from('\\x1b[B'))){cursor=2;changed=swap;render();}if(data.includes(13)){fs.writeFileSync(marker,String(cursor));process.stdout.write('\\x1b[2J\\x1b[H> ');}});render();setInterval(()=>{},1000);";
const results: unknown[] = [];
try {
  for (const swap of [true, false]) {
    const name = swap ? "swap" : "control", script = join(root, `${name}.cjs`), marker = join(root, `${name}.submitted`);
    writeFileSync(script, child);
    tmux("-f", "/dev/null", "new-session", "-d", "-s", name, "-x", "100", "-y", "64", "-c", root, `${quote(process.execPath)} ${quote(script)} ${quote(marker)} ${quote(swap ? "true" : "false")}`);
    const capture = () => tmux("capture-pane", "-p", "-t", name);
    let card = null as ReturnType<typeof selectionCard>;
    for (let i = 0; i < 100 && !card; i++) { await sleep(50); card = selectionCard(capture(), "Claude Code"); }
    assert(card, "real mock pane rendered"); const keys: string[] = [];
    const outcome = await answerRemoteCard({ locked: async fn => fn(), read: async () => capture(), key: async key => { keys.push(key); tmux("send-keys", "-t", name, key); return true; }, paste: async () => false, sleep, now: () => performance.now() }, p => selectionCard(p, "Claude Code"), card.identity, { kind: "option", n: 2 });
    console.log(JSON.stringify({ swap, outcome, keys, physicalSubmit: existsSync(marker) }));
    if (swap) { assert.equal(outcome.outcome, "stopped"); assert.deepEqual(keys, ["Down"]); assert(!existsSync(marker), "no Enter physically reached replacement"); }
    else { assert.equal(outcome.outcome, "answered"); assert.deepEqual(keys, ["Down", "Enter"]); assert.equal(readFileSync(marker, "utf8"), "2"); }
    results.push({ swap, outcome, keys, submitted: existsSync(marker) }); tmux("kill-session", "-t", name);
  }
} finally {
  try { tmux("kill-server"); } catch { /* only private owned server */ }
  rmSync(root, { recursive: true, force: true });
}
writeFileSync(join(output, "receipt.json"), JSON.stringify({ sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), privateSocket: socket, results, passed: true, scratchRemoved: !existsSync(root) }, null, 2));
console.log("PASS: physical private-tmux swap withheld Enter; unchanged control submitted exactly once");
