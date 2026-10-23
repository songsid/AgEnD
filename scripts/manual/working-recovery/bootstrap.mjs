/** Fixture-only observation boundaries. Loaded only in the private packaged fleet. */
import { appendFileSync, existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
const root = "/opt/rehearsal";
if (process.argv[1]?.endsWith("/dist/cli.js") && process.argv.includes("fleet") && process.argv.includes("start")) {
  if (!existsSync("/.dockerenv") || process.env.AGEND_WORKING_REHEARSAL !== "1") throw Error("private rehearsal required");
  const remaining = Number(readFileSync(`${root}/boot-faults`, "utf8"));
  if (remaining > 0) {
    writeFileSync(`${root}/boot-faults`, String(remaining - 1));
    appendFileSync(`${root}/timeline.jsonl`, JSON.stringify({ at: Date.now(), pid: process.pid, event: "pre-ready-boot-exit" }) + "\n");
    process.exit(29);
  }
  const pkg = `${root}/prefix/lib/node_modules/@songsid/agend/dist`;
  const { MemoryPressure } = await import(`${pkg}/memory-pressure.js`);
  const start = MemoryPressure.prototype.start;
  MemoryPressure.prototype.start = function () {
    this.read = () => ({ totalBytes: 16e9,
      availableBytes: readFileSync(`${root}/pressure`, "utf8") === "normal" ? 8e9 : 600e6,
      availableKind: "available", swapTotalBytes: 0, swapFreeBytes: 0, linuxPsi: { someAvg60: 0, fullAvg10: 0 } });
    return start.call(this);
  };
  const { WorkingRecoveryCoordinator } = await import(`${pkg}/working-recovery.js`);
  const ready = WorkingRecoveryCoordinator.prototype.ready;
  WorkingRecoveryCoordinator.prototype.ready = function () {
    appendFileSync(`${root}/timeline.jsonl`, JSON.stringify({ at: Date.now(), pid: process.pid, event: "final-ready" }) + "\n");
    return ready.call(this);
  };
  const { Daemon } = await import(`${pkg}/daemon.js`);
  const checkpoint = Daemon.prototype.saveSessionId;
  Daemon.prototype.saveSessionId = function () {
    checkpoint.call(this);
    // Mock has a directly owned instance file. Production backend ownership is
    // deliberately unchanged; separate unit controls test unknown ownership.
    if (this.config.backend === "mock") this.ownedWorkingSession = this.backend.getSessionId();
  };
  const { MockBackend } = await import(`${pkg}/backend/mock.js`);
  MockBackend.prototype.readInputRow = () => ({ text: "", collapsedPastes: 0 });
  // The fixture is a readline CLI, so tell the real TTY guard its input mode.
  const delivery = Daemon.prototype.deliverWorkingRecovery;
  Daemon.prototype.deliverWorkingRecovery = async function (...args) {
    const originalMode = this.tmux.getPaneInputMode;
    const originalProof = this.confirmSubmitted;
    const receipts = `${root}/physical-input.jsonl`;
    const count = () => existsSync(receipts) ? readFileSync(receipts, "utf8").trim().split("\n").filter(Boolean).length : 0;
    const before = count();
    this.tmux.getPaneInputMode = async () => "raw";
    this.confirmSubmitted = async () => {
      const until = Date.now() + 5_000;
      while (Date.now() < until && count() === before) await new Promise(resolve => setTimeout(resolve, 50));
      if (count() === before) return "stranded";
      if (existsSync(`${root}/kill-after-input`)) {
        unlinkSync(`${root}/kill-after-input`);
        appendFileSync(`${root}/timeline.jsonl`, JSON.stringify({ at: Date.now(), pid: process.pid, event: "kill-after-observed-input" }) + "\n");
        process.kill(process.pid, "SIGKILL");
      }
      return "submitted";
    };
    try { return await delivery.apply(this, args); }
    finally { this.tmux.getPaneInputMode = originalMode; this.confirmSubmitted = originalProof; }
  };
}
