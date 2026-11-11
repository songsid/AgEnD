/** Offline recorded-stream replay through real Daemon/Outbox; private tmux only, no backend process or network. */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const repo = process.env.REPO!,
  fixtures =
    process.env.FIXTURES ?? join(repo, "tests/fixtures/codex-pane-owner-2301"),
  out = process.env.OUT!;
const parent = mkdtempSync(join(tmpdir(), "codex-replay2301-"));
process.env.HOME = parent;
process.env.AGEND_HOME = join(parent, "agend");
process.env.CODEX_HOME = join(parent, "shared");
const { Daemon } = await import(repo + "/src/daemon.ts");
const { CodexBackend } = await import(repo + "/src/backend/codex.ts");
const { DeliveryOutbox } = await import(repo + "/src/delivery-outbox.ts");
const selected = readFileSync(join(fixtures, "rollout.selected.jsonl"), "utf8")
  .trimEnd()
  .split("\n");
const id = JSON.parse(selected[0]).payload.id,
  text = JSON.parse(selected[1]).payload.content[0].text;
const log: any = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return this;
  },
};
const receipts: any[] = [];
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
try {
  for (const mode of process.env.BASELINE
    ? ["baseline"]
    : ["owned", "switched", "replaced", "narrow"]) {
    const root = join(parent, mode),
      instance = join(root, "instances", "worker"),
      sessions = join(root, "sessions");
    mkdirSync(instance, { recursive: true });
    mkdirSync(sessions);
    const path = join(sessions, `rollout-captured-${id}.jsonl`),
      socket = join(root, "tmux.sock");
    const tmux = (...a: string[]) =>
      execFileSync("/usr/bin/tmux", ["-f", "/dev/null", "-S", socket, ...a], {
        encoding: "utf8",
      });
    const meta = JSON.parse(selected[0]);
    meta.payload.cwd = root;
    writeFileSync(path, JSON.stringify(meta) + "\n");
    const script = join(root, "render.py");
    writeFileSync(
      script,
      `import sys,time,termios,json\nfrom pathlib import Path\nr=Path(sys.argv[1]);f=Path(sys.argv[2]);mode=sys.argv[3]\ns=termios.tcgetattr(0);s[3]&=~termios.ECHO;termios.tcsetattr(0,termios.TCSANOW,s)\ndef paint(n):sys.stdout.write('\\033[H\\033[2J'+(f/n).read_text());sys.stdout.flush()\npaint('after-ready-120.pane.txt');(r/'ready').touch()\nline=sys.stdin.readline().rstrip('\\r\\n')\nif line!=${JSON.stringify(text)}:raise RuntimeError('unexpected input')\np=Path(sys.argv[4]);entry=${JSON.stringify(selected[1])}\nif mode=='replaced':\n p.rename(str(p)+'.old');p.write_text(Path(str(p)+'.old').read_text())\nwith p.open('a') as h:h.write(entry+'\\n')\nif mode=='switched':\n frame=(f/'after-fast.pane.txt').read_text().replace(${JSON.stringify(id)},'02'+${JSON.stringify(id)}[2:]);sys.stdout.write('\\033[H\\033[2J'+frame);sys.stdout.flush()\nelif mode=='narrow':paint('after-ready-80.pane.txt')\nelse:paint('after-fast.pane.txt')\n(r/'accepted').touch();time.sleep(30)\n`,
    );
    const box = new DeliveryOutbox(join(root, "outbox.db"), "replay");
    const backend: any = new CodexBackend(instance);
    backend.isolatedCodexHome = root;
    const d: any = new Daemon(
      "worker",
      {
        working_directory: root,
        backend: "codex",
        restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
        context_guardian: { max_age_hours: 4, grace_period_ms: 600000 },
      } as any,
      instance,
      false,
      backend,
      {
        getObservationResetAt: () => 0,
        getLastOutputAt: () => undefined,
        isIdle: () => true,
        waitUntilIdle: async () => true,
        hasOutputSince: () => false,
      } as any,
      log,
    );
    let pastes = 0;
    const keys: string[] = [];
    try {
      tmux(
        "new-session",
        "-d",
        "-s",
        "owned",
        "-x",
        "120",
        "-y",
        "24",
        "python3",
        script,
        root,
        fixtures,
        mode,
        path,
      );
      for (let n = 0; n < 200 && !existsSync(join(root, "ready")); n++)
        await pause(10);
      if (!existsSync(join(root, "ready")))
        throw Error("renderer did not become ready");
      const windowId = tmux(
        "display-message",
        "-p",
        "-t",
        "owned",
        "#{window_id}",
      ).trim();
      writeFileSync(join(instance, "window-id"), windowId);
      d.tmux = {
        getWindowId: () => windowId,
        capturePane: async () => tmux("capture-pane", "-p", "-t", "owned"),
        pasteBuffer: async (content: string) => {
          pastes++;
          tmux("set-buffer", "--", content);
          tmux("paste-buffer", "-p", "-t", "owned");
          return true;
        },
        sendSpecialKey: async (key: string) => {
          keys.push(key);
          tmux("send-keys", "-t", "owned", key);
          return true;
        },
      };
      d.setDeliveryOutboxPort(box);
      d.transcriptMonitor = {
        reconciliationCheckpoint: async () => ({
          path,
          offset: Buffer.byteLength(JSON.stringify(meta) + "\n"),
          sessionId: path,
        }),
      };
      // Startup/idle IPC is outside this replay; the actual before-write/footer/rollout/submission judges run unchanged.
      d.wake = async () => {};
      d.waitForInputTransientToClear = async () => true;
      d.paneReadinessForDelivery = async () => "ready";
      d.hasPositiveDeliveryInput = async () => true;
      d.waitForPaneReadyForDelivery = async () => true;
      const row = box.admit({
        operationId: "replay2301",
        sourceKey: "schedule:2301:worker:raw_paste",
        sourceInstance: "fleet",
        sourceDaemonBootId: "source",
        targetInstance: "worker",
        kind: "raw_paste",
        payload: { type: "raw_paste", content: text },
      }).delivery;
      const claim = box.claimNext("replay", () => d.bootId, new Set())!,
        started = performance.now();
      d.queueRawPaste(text, d.deliveryEpoch, false, {
        deliveryId: row.deliveryId,
        attemptNo: claim.attemptNo,
        submissionMode: "raw_paste",
      });
      for (
        let n = 0;
        n < 1000 &&
        ["delivering", "submission_started"].includes(
          box.get(row.deliveryId)!.state,
        );
        n++
      )
        await pause(20);
      const state = box.get(row.deliveryId)!.state;
      const expected = mode === "owned" ? "delivered" : "uncertain";
      const receipt = {
        mode,
        state,
        expected,
        pastes,
        keys,
        accepted: existsSync(join(root, "accepted")),
        elapsedMs: Math.round(performance.now() - started),
      };
      receipts.push(receipt);
      if (
        state !== expected ||
        pastes !== 1 ||
        JSON.stringify(keys) !== '["Enter"]' ||
        !receipt.accepted
      )
        throw Error("replay mismatch " + JSON.stringify(receipt));
    } finally {
      d.fenceDeliveryWritesForStop();
      try {
        tmux("kill-server");
      } catch {}
      box.close?.();
    }
  }
  writeFileSync(
    out,
    JSON.stringify(
      {
        source: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        scope:
          "recorded Codex0.167 mock-only stream; real Daemon/Outbox; private tmux replay; no backend CLI/account/network",
        receipts,
        cleanup: { privateTmuxStopped: true, scratchRemoved: true },
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  rmSync(parent, { recursive: true, force: true });
}
