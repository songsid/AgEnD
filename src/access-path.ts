import { join } from "node:path";

/**
 * Constraint on an instance name when it is going to be used as a path segment.
 * Unicode is deliberately allowed (instance names may be non-ASCII), but path
 * separators, traversal, and control characters are not: a NUL or other control
 * byte has no legitimate use in a filename and behaves inconsistently across
 * syscalls, so it is rejected here rather than reaching the filesystem.
 *
 * Empty / pure-`.` / pure-`..` / anything containing `..` is rejected so we cannot
 * escape `dataDir/instances/`.
 *
 * Defence-in-depth: callers (CLI / fleet config loader) already constrain
 * instance names, but `resolveAccessPathFromConfig` is invoked from several
 * entry points and the consequence of a traversal here is reading or writing
 * an attacker-supplied file path.
 */
const PATH_SEPARATOR_OR_CONTROL = /[/\\\u0000-\u001f\u007f]/;

function assertSafeInstanceName(instance: string): void {
  if (
    !instance
    || PATH_SEPARATOR_OR_CONTROL.test(instance)
    || instance === "."
    || instance === ".."
    || instance.includes("..")
  ) {
    throw new Error(`Invalid instance name "${instance}" — must not contain path separators, traversal, or control characters`);
  }
}

/**
 * Resolve the access.json path for an instance.
 * Topic mode uses fleet-level access; otherwise per-instance.
 *
 * Throws if `instance` is not a safe path segment (per-instance mode only;
 * topic mode does not embed `instance` in the returned path).
 */
export function resolveAccessPathFromConfig(
  dataDir: string,
  instance: string,
  fleetChannel: { mode?: string } | undefined,
): string {
  if (fleetChannel?.mode === "topic") {
    return join(dataDir, "access", "access.json");
  }
  assertSafeInstanceName(instance);
  return join(dataDir, "instances", instance, "access.json");
}
