import { readFileSync } from "node:fs";

/** Fixed packaged asset; caller authenticates the setup session first. */
export function setupSignInScript(): string {
  return readFileSync(new URL("./ui/structured-signin.js", import.meta.url), "utf8");
}
