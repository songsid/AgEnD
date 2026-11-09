/**
 * Whether this process runs inside WSL (#3270). Shared by `agend web` (what it opens, what code lifetime it asks for) and
 * the fleet's `/auth/issue-code` (which refuses the first-install lifetime there): on WSL2, localhost forwarding hands the
 * fleet every connection from a Windows process of the user as loopback, and those processes can read the distro's files
 * (`\\wsl$`), so "loopback only" does not mean "this shell only" and the ordinary 5-minute code stays.
 */
import { readFileSync } from "node:fs";

export function isWsl(env: NodeJS.ProcessEnv = process.env, readVersion: () => string = () => readFileSync("/proc/version", "utf8")): boolean {
  if (env.AGEND_WSL === "0") return false;                               // tests, and a machine the detection gets wrong
  if (env.AGEND_WSL === "1" || env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  try { return /microsoft|wsl/i.test(readVersion()); } catch { return false; }
}
