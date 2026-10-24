// ipc.mjs <socket> <dir>: the kiro TUI's test IPC peer (KIRO_TEST_TUI_IPC_SOCKET_PATH). The TUI connects here; every
// <dir>/cmd-*.json file is sent to it as one command ({id, kind:"command", data}) and the answer is appended to <dir>/log.
import net from "node:net"; import fs from "node:fs";
const [sock, dir] = process.argv.slice(2);
try { fs.unlinkSync(sock); } catch {}
let id = 0, conn = null, buf = "";
const log = s => fs.appendFileSync(dir + "/log", `${Date.now()} ${s}\n`);
net.createServer(c => { conn = c; log("tui connected"); c.setEncoding("utf8");
  c.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { log("< " + buf.slice(0, i).slice(0, 600)); buf = buf.slice(i + 1); } });
  c.on("close", () => { log("tui closed"); conn = null; }); }).listen(sock, () => log("listening " + sock));
setInterval(() => { if (!conn) return; for (const f of fs.readdirSync(dir).filter(f => /^cmd-.*\.json$/.test(f)).sort()) {
  const data = JSON.parse(fs.readFileSync(dir + "/" + f, "utf8")); fs.renameSync(dir + "/" + f, dir + "/sent-" + f);
  const line = JSON.stringify({ id: "a" + ++id, kind: "command", data }); log("> " + line.slice(0, 600)); conn.write(line + "\n"); } }, 200);
