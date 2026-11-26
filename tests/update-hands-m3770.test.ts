// M-3770 slice 2.5, wiring part 5 (design update-wiring-m3770.md §3, §10.1): the updater's install hand — the target's
// own installer in install-only mode with this update's prefix-lock token, from the filesystem root, then the installed
// package.json read again: its exact version, and its own agend.updateTx (below 1 → roll back, never trial).
import { describe, expect, it } from "vitest";
import { installHand, type InstallHandEnv } from "../src/update-hands.js";

const PKG = "/p/lib/node_modules/@songsid/agend";
const input = { name: "@songsid/agend", version: "2.5.1", packagePath: PKG, prefixToken: "f".repeat(32) };
function env(o: { status?: number | null; pkg?: unknown } = {}) {
  const calls: { command: string; args: string[]; token?: string; cwd: string }[] = [];
  const x: InstallHandEnv = {
    env: { PATH: "/bin", AGEND_INSTALL_TOKEN: "stale" }, cwd: "/home/u/project",
    run: (command, args, opts) => { calls.push({ command, args, token: opts.env.AGEND_INSTALL_TOKEN, cwd: opts.cwd }); return { status: o.status === undefined ? 0 : o.status }; },
    readFile: path => (path === `${PKG}/package.json` ? JSON.stringify(o.pkg === undefined ? { name: "@songsid/agend", version: "2.5.1", agend: { updateTx: 1 } } : o.pkg) : null),
  };
  return { x, calls };
}

describe("M-3770 2.5 wiring part 5: the install hand", () => {
  it("runs the target's own installer, install-only, pinned, with this update's token, from the filesystem root; ok when the installed package is the target and speaks the transaction", () => {
    const e = env();
    expect(installHand(input, e.x)).toEqual({ ok: true });
    expect(e.calls).toEqual([{ command: "npm", args: ["exec", "--yes", "--package", "@songsid/agend@2.5.1", "--", "agend-install", "--install-only", "--target", "2.5.1"],
      token: "f".repeat(32), cwd: "/" }]);
  });

  it("an installed release whose own package.json doesn't speak the transaction is refused (the update rolls back)", () => {
    for (const agend of [undefined, { updateTx: 0 }, { updateTx: "1" }]) {
      const e = env({ pkg: { name: "@songsid/agend", version: "2.5.1", ...(agend ? { agend } : {}) } });
      expect(installHand(input, e.x)).toEqual({ ok: false, reason: `the installed @songsid/agend@2.5.1 doesn't speak the update transaction (agend.updateTx 0)` });
    }
  });

  it("another version, another package or no package.json after the install is refused", () => {
    for (const pkg of [{ name: "@songsid/agend", version: "2.5.0", agend: { updateTx: 1 } }, { name: "other", version: "2.5.1" }, null]) {
      expect(installHand(input, env({ pkg }).x)).toEqual({ ok: false, reason: `after the install, ${PKG} isn't @songsid/agend@2.5.1` });
    }
  });

  it("the installer's own refusals: not admitted (75), failed (1), or never ran", () => {
    expect(installHand(input, env({ status: 75 }).x)).toEqual({ ok: false, reason: "the installer of @songsid/agend@2.5.1 wasn't admitted under this update's prefix lock" });
    expect(installHand(input, env({ status: 1 }).x)).toEqual({ ok: false, reason: "the installer of @songsid/agend@2.5.1 failed (exit 1)" });
    expect(installHand(input, env({ status: null }).x)).toEqual({ ok: false, reason: "the installer of @songsid/agend@2.5.1 failed (exit unknown)" });
  });

  it("only an exact version: a tag never reaches npm", () => {
    const e = env();
    expect(installHand({ ...input, version: "beta" }, e.x)).toEqual({ ok: false, reason: "the target beta isn't an exact version" });
    expect(e.calls).toEqual([]);
  });
});
