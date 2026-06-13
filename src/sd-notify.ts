import { execFileSync } from "node:child_process";

export function sdNotify(state: string): void {
  if (!process.env.NOTIFY_SOCKET) return;
  try {
    execFileSync("systemd-notify", [state], { stdio: "ignore", timeout: 5000 });
  } catch { /* best effort */ }
}
