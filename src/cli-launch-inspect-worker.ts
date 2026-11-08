import { parentPort, workerData } from "node:worker_threads";
import { inspectClaudeLaunch } from "./cli-launch-inspect.js";
const input = workerData as {
  pid: number;
  path: string;
};
try {
  parentPort?.postMessage(inspectClaudeLaunch(input.pid, input.path));
}
catch {
  parentPort?.postMessage(null);
}
finally {
  parentPort?.close();
}
