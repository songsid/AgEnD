/**
 * #2481: the first thing `fleet start` does — before the rest of dist/cli.js's module graph is evaluated (this is its
 * first import), so a fleet that dies anywhere later in its start still counts the attempt. See start-failure.ts.
 * Every other command, and any failure here, does nothing: recording an attempt must never stop a start.
 */
import { getAgendHome } from "./paths.js";
import { notifyOnce, ownPackage, recordStartAttempt } from "./start-failure.js";

if (process.argv[2] === "fleet" && process.argv[3] === "start") {
  try {
    const version = ownPackage().version;
    if (version) {
      const home = getAgendHome();
      notifyOnce(home, recordStartAttempt(home, version, Date.now()));
    }
  } catch { /* never in the way of a start */ }
}
