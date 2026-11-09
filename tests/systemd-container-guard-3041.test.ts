/**
 * #3041: the systemd rehearsal containers never touch the host's binfmt_misc. The guard's check runs here against
 * fixture directory trees (no Docker, no container): an image passes only with every known binfmt unit masked in
 * /etc/systemd/system — whether or not a vendor copy exists — no binfmt.d entry, and the non-privileged entrypoint.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const LIB = join(__dirname, "..", "scripts", "manual", "lib", "systemd-container.sh");
const UNITS = ["systemd-binfmt.service", "binfmt-support.service", "proc-sys-fs-binfmt_misc.automount", "proc-sys-fs-binfmt_misc.mount"];
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function file(root: string, path: string, text = "", mode = 0o644): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
  chmodSync(join(root, path), mode);
}
function link(root: string, path: string, target: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  symlinkSync(target, join(root, path));
}
/** A tree the guard accepts: every unit masked, no binfmt.d entry, the entrypoint present. */
function clean(): string {
  const root = mkdtempSync(join(tmpdir(), "guard-3041-"));
  roots.push(root);
  for (const u of UNITS) link(root, `etc/systemd/system/${u}`, "/dev/null");
  file(root, "usr/local/sbin/systemd-container-init", "#!/bin/sh\n", 0o755);
  mkdirSync(join(root, "usr/lib/binfmt.d"), { recursive: true });
  return root;
}
function check(root: string): string[] {
  const out = execFileSync("bash", ["-c", `. "$1"; systemd_container_check_root "$2"`, "guard", LIB, root], { encoding: "utf-8" });
  return out.split("\n").filter(Boolean);
}

describe("the rehearsal image guard (#3041)", () => {
  it("accepts a tree with every binfmt unit masked, no binfmt.d entry and the entrypoint", () => {
    expect(check(clean())).toEqual([]);
  });

  it("a unit enabled only by configuration (no vendor copy, no binfmt.d entry): refused", () => {
    const root = clean();
    rmSync(join(root, "etc/systemd/system/systemd-binfmt.service"));
    file(root, "etc/systemd/system/systemd-binfmt.service", "[Service]\nExecStart=/lib/systemd/systemd-binfmt\n");
    link(root, "etc/systemd/system/sysinit.target.wants/systemd-binfmt.service", "/etc/systemd/system/systemd-binfmt.service");
    expect(check(root)).toEqual(["unit systemd-binfmt.service is not masked"]);
  });

  it("a vendor unit with no mask, or a 'mask' that points anywhere but /dev/null: refused", () => {
    const a = clean();
    rmSync(join(a, "etc/systemd/system/binfmt-support.service"));
    file(a, "lib/systemd/system/binfmt-support.service", "[Service]\n");
    expect(check(a)).toEqual(["unit binfmt-support.service is not masked"]);
    const b = clean();
    rmSync(join(b, "etc/systemd/system/proc-sys-fs-binfmt_misc.mount"));
    link(b, "etc/systemd/system/proc-sys-fs-binfmt_misc.mount", "/lib/systemd/system/proc-sys-fs-binfmt_misc.mount");
    expect(check(b)).toEqual(["unit proc-sys-fs-binfmt_misc.mount is not masked"]);
  });

  it("any binfmt.d entry (a file or a dangling link), or no entrypoint: refused", () => {
    const root = clean();
    file(root, "usr/lib/binfmt.d/python3.10.conf", ":python3.10:M::\\x6f\\x0d\\x0d\\x0a::/usr/bin/python3.10:\n");
    link(root, "etc/binfmt.d/gone.conf", "/nowhere");
    rmSync(join(root, "usr/local/sbin/systemd-container-init"));
    expect(check(root)).toEqual([
      "binfmt.d entry /usr/lib/binfmt.d/python3.10.conf",
      "binfmt.d entry /etc/binfmt.d/gone.conf",
      "no non-privileged systemd entrypoint",
    ]);
  });

  it("each systemd rehearsal derives and guards its image before docker run, and never runs --privileged", () => {
    for (const name of ["oom-recovery", "startup-memory", "working-recovery"]) {
      const text = readFileSync(join(__dirname, "..", "scripts", "manual", name, "run.sh"), "utf-8");
      expect(text, name).not.toContain("--privileged");
      const derive = text.indexOf("image=$(systemd_container_image");
      const guard = text.indexOf('systemd_container_guard "$image"');
      const run = text.indexOf('docker run -d "${SYSTEMD_CONTAINER_FLAGS[@]}"');
      expect(derive, name).toBeGreaterThan(0);
      expect(guard, name).toBeGreaterThan(derive);
      expect(run, name).toBeGreaterThan(guard);
      expect(text.slice(run), name).toContain('"$image"');
    }
  });
});
