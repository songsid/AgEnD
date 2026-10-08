/**
 * Runtime version guard: better-sqlite3 v13 requires Node-API 10.
 *
 * Node-API 10 is available from:
 *   Node 22.14.0 (LTS) — released 2025-02-06
 *   Node 23.6.0         — released 2025-01-13
 *   Node 24+            — all releases
 *
 * This function is exported so tests can verify the exact boundary without
 * duplicating the logic. The CLI bootstrap calls checkNodeVersion() at the
 * very top so that even the OLD updater's `agend --version` verification
 * will fail on an incompatible runtime, aborting the install.
 *
 * References:
 *   https://github.com/WiseLibs/better-sqlite3/blob/v13.0.3/binding.gyp
 *   https://nodejs.org/api/n-api.html#node-api-version-matrix
 */

/** Returns true when the running Node supports N-API 10. */
export function isNodeCompatible(nodeVersion = process.versions.node): boolean {
  const [majStr, minStr] = nodeVersion.split(".");
  const maj = parseInt(majStr, 10);
  const min = parseInt(minStr, 10);
  if (maj >= 24) return true;
  if (maj === 23 && min >= 6) return true;
  if (maj === 22 && min >= 14) return true;
  return false;
}

/**
 * Call at binary bootstrap. Prints a clear error and calls process.exit(1)
 * when the running Node cannot load better-sqlite3's N-API 10 prebuilt.
 *
 * Placing this guard at bootstrap means:
 * - `agend --version` exits 1 on incompatible Node
 * - The OLD updater's verification step (`agend --version` → failUpdate on
 *   non-zero) aborts the install rather than letting a restart crash the fleet
 * - Any DB command (`schedule list`, daemon start, …) is also blocked
 */
export function checkNodeVersion(): void {
  if (!isNodeCompatible()) {
    process.stderr.write(
      `agend requires Node.js ^22.14.0 || ^23.6.0 || >=24.\n` +
      `better-sqlite3 v13 uses Node-API 10, available from Node 22.14.0 / 23.6.0 / 24+.\n` +
      `Running: Node ${process.version}.\n` +
      `Upgrade Node first (e.g. nvm install 22), then restart.\n`,
    );
    process.exit(1);
  }
}
