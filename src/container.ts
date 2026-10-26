/**
 * #581: AgEnD running in its container image (Dockerfile / compose.yaml at the repo root). The image sets
 * AGEND_CONTAINER=1; everything that would manage the host — a self-update, a systemd/launchd service, a detached
 * replacement fleet — is the container runtime's job there: the image is updated by pulling it, and Docker's restart
 * policy is the supervisor. Off the image (AGEND_CONTAINER unset) nothing here changes behaviour.
 */
import { isIP } from "node:net";

/** The fleet runs in AgEnD's container image. */
export function inContainer(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGEND_CONTAINER === "1";
}

/** How a container install is updated, for every refusal and notice to quote. */
export const CONTAINER_UPDATE_COMMAND = "docker compose pull && docker compose up -d";

/**
 * Where the web dashboard listens. Always 127.0.0.1 on a host. In the container a published port reaches only an
 * address inside it, so AGEND_WEB_BIND (the image sets 0.0.0.0) may name another literal IP; compose publishes it on
 * the host's 127.0.0.1 by default, so the dashboard stays host-local unless the person changes the port mapping.
 */
export function webListenHost(env: NodeJS.ProcessEnv = process.env): string {
  const requested = env.AGEND_WEB_BIND?.trim();
  if (!inContainer(env) || !requested) return "127.0.0.1";
  return isIP(requested) ? requested : "127.0.0.1";
}

/** What `agend <command>` says in the container instead of managing the host (null: the command runs as usual). */
export function containerRefusal(command: "update" | "install" | "stop", env: NodeJS.ProcessEnv = process.env): string | null {
  if (!inContainer(env)) return null;
  switch (command) {
    case "update": return `This AgEnD runs in a container, so it is updated by pulling its image, not by \`agend update\`. On the host: ${CONTAINER_UPDATE_COMMAND}`;
    case "install": return "This AgEnD runs in a container: Docker's restart policy supervises the fleet, so there is no service to install.";
    case "stop": return "This AgEnD runs in a container: Docker would start a stopped fleet again. On the host: docker compose stop (or docker compose down).";
  }
}

/**
 * `agend restart` in the container: the fleet process is the container's main process, so stopping it ends the
 * container and Docker's restart policy (compose: `restart: unless-stopped`) starts it again. A detached replacement
 * fleet, as on a host without a service, would die with the container. Returns the line to print, or why not.
 */
export function restartInContainer(pid: number, kill: (pid: number, signal: NodeJS.Signals) => void = (p, s) => { process.kill(p, s); }): { ok: boolean; message: string } {
  if (!Number.isSafeInteger(pid) || pid <= 1) return { ok: false, message: "No running fleet found in this container (fleet.pid is missing or invalid)." };
  try { kill(pid, "SIGTERM"); }
  catch { return { ok: false, message: `Could not signal the fleet (PID ${pid}); it may have exited already.` }; }
  return { ok: true, message: "Stopping the fleet; Docker's restart policy starts the container again in a few seconds." };
}
