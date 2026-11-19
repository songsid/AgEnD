/** Manual fault injection: hold the captured verdict until this fixture observes its output-completion signal. */
import child from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

if (process.env.AGEND_TEST_LATE_VERDICT === "1") {
  const nativeSync = child.spawnSync, nativeAsync = child.spawn;
  let completionObserved = false;
  const isTmux = command => basename(String(command)) === "tmux";
  function ownedSocket(args) {
    if (!Array.isArray(args)) return false;
    const socket = args.indexOf("-S"), label = args.indexOf("-L");
    if (socket >= 0) return String(args[socket + 1]).startsWith(join(tmpdir(), "agend-2980-"));
    return label >= 0 && (args[label + 1] === `agend-test-2980-${process.pid}` || args.includes("-V") && args[label + 1] === "agend-test-2980-probe");
  }
  child.spawnSync = function (command, args = [], options) {
    if (isTmux(command) && !ownedSocket(args)) throw Error("reproducer refuses a non-fixture tmux socket");
    const result = nativeSync.call(this, command, args, options);
    if (isTmux(command) && args.includes("capture-pane") && !completionObserved && typeof result.stdout === "string") {
      result.stdout = result.stdout.split("\n").filter(line => !line.includes("AGEND-INSTALL-EXIT-")).join("\n");
    }
    return result;
  };
  child.spawn = function (command, args = [], options) {
    if (!isTmux(command)) return nativeAsync.call(this, command, args, options);
    if (!ownedSocket(args)) throw Error("reproducer refuses a non-fixture tmux socket");
    const result = nativeAsync.call(this, command, args, options), at = args.indexOf("wait-for");
    if (at >= 0 && !args.slice(at + 1).includes("-S")) result.once("exit", code => { if (code === 0) completionObserved = true; });
    return result;
  };
  syncBuiltinESMExports();
}
