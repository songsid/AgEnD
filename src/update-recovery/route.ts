/**
 * M-3770 slice 2.1c part 3 (design update-transaction §6.2): the service route — how the pre-start step reaches every
 * start of the attempt's service — written before the install (under the service lock) and taken off after the
 * takeover is acknowledged.
 *
 * - **systemd:** a drop-in `<fragment dir>/<unit>.d/agend-update-recovery.conf`:
 *       [Service]
 *       ExecStartPre=<kit>/node <kit>/recover.cjs --home <home> --attempt <id> --pre-start
 *       EnvironmentFile=-<home>/.update-journal/attempts/<id>/handoff.env
 *   The unit file itself is untouched. Paths are written only when every character is plainly safe in a unit file
 *   (no whitespace, quotes, `%` specifiers or `$` expansions); anything else refuses the route (the attempt abandons).
 * - **launchd:** the plist's `ProgramArguments` wrapped. Node can't exec, and launchd's MainPID must be the fleet, so
 *   the wrapper is `/bin/sh`: it runs the pre-start step, takes the nonce from `handoff.env` (read, never sourced: only
 *   `AGEND_UPDATE_HANDOFF=<32 hex>` is accepted), and `exec`s the original arguments:
 *       ["/bin/sh", "-c", WRAPPER_SCRIPT, "agend-update-recovery", <kit>/node, <kit>/recover.cjs, <home>, <id>, ...original]
 *   With no open attempt the pre-start exits 0 and the wrapper only execs the original arguments.
 *
 * The definition's own bytes are kept first as `attempts/<id>/unit.preimage` (never overwritten): the route's removal
 * and §6.3's unit restore put them back. `unwrapRecoveryRoute` recognises the wrapper EXACTLY (design §6.2, "P3 accepts
 * the wrapper only when it is exactly this"), for the tuple checks that read launchd's loaded arguments.
 */
import { closeSync, fchmodSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { attemptDir, defaultJournalIo, mkdirDurable, readAttemptRecord, readCurrent, TERMINAL, type AttemptRecord, type JournalIo } from "../update-journal.js";
import { identityOf, type OwnedService } from "../install-ownership.js";
import { handoffEnvPath, kitDir } from "./pre-start.js";

export const DROP_IN_NAME = "agend-update-recovery.conf";
export const WRAPPER_ARG0 = "agend-update-recovery";
export const UNIT_PREIMAGE = "unit.preimage";

const NONCE_CASE = Array.from({ length: 32 }, () => "[0-9a-f]").join("");
/**
 * The launchd wrapper's script ($1 kit node, $2 recover.cjs, $3 home, $4 attempt; then the original arguments). Kept
 * byte-for-byte: `unwrapRecoveryRoute` compares it exactly.
 */
export const WRAPPER_SCRIPT = [
  `"$1" "$2" --home "$3" --attempt "$4" --pre-start || exit $?`,
  `f="$3/.update-journal/attempts/$4/handoff.env"`,
  `if [ -f "$f" ]; then`,
  `  IFS= read -r line < "$f" || true`,
  `  case "$line" in`,
  `    AGEND_UPDATE_HANDOFF=${NONCE_CASE}) AGEND_UPDATE_HANDOFF=\${line#AGEND_UPDATE_HANDOFF=}; export AGEND_UPDATE_HANDOFF ;;`,
  `  esac`,
  `fi`,
  `shift 4`,
  `exec "$@"`,
].join("\n");

export const dropInPath = (service: OwnedService) => join(dirname(service.fragmentPath), `${service.unit}.d`, DROP_IN_NAME);
export const unitPreimagePath = (home: string, attemptId: string) => join(attemptDir(home, attemptId), UNIT_PREIMAGE);

/** A path a unit file can carry as one bare word: no whitespace, quotes, backslashes, `%` specifiers or `$` expansions. */
const unitSafe = (path: string) => /^\/[A-Za-z0-9_./@+:,-]*$/.test(path);

/** tmp (fresh, O_EXCL, `mode`) → fsync → rename → directory fsync. A file it replaces keeps its mode (`mode: "keep"`). */
function writeDurable(path: string, data: string | Buffer, io: JournalIo, mode: number | "keep" = 0o600): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
  const fileMode = mode === "keep" ? statSync(path).mode & 0o7777 : mode;
  const fd = openSync(tmp, "wx", fileMode);
  try { writeSync(fd, typeof data === "string" ? Buffer.from(data) : data); fchmodSync(fd, fileMode); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  io.fsyncDir(dirname(path));
}

/** The drop-in's exact text for an attempt. */
export function dropInText(home: string, attemptId: string): string {
  const kit = kitDir(home, attemptId);
  return [
    "# AgEnD update recovery (M-3770): every start of this service first asks the update journal.",
    "[Service]",
    `ExecStartPre=${join(kit, "node")} ${join(kit, "recover.cjs")} --home ${home} --attempt ${attemptId} --pre-start`,
    `EnvironmentFile=-${handoffEnvPath(home, attemptId)}`,
    "",
  ].join("\n");
}

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const PROGRAM_ARGS = /(<key>ProgramArguments<\/key>\s*<array>)([\s\S]*?)(\s*<\/array>)/;

/** The plist with its ProgramArguments wrapped; null when it has no (single) ProgramArguments array or a `Program` key. */
export function wrapPlist(xml: string, home: string, attemptId: string, originalArgs: string[]): string | null {
  if (/<key>Program<\/key>/.test(xml) || (xml.match(/<key>ProgramArguments<\/key>/g) ?? []).length !== 1) return null;
  const kit = kitDir(home, attemptId);
  const words = ["/bin/sh", "-c", WRAPPER_SCRIPT, WRAPPER_ARG0, join(kit, "node"), join(kit, "recover.cjs"), home, attemptId, ...originalArgs];
  return xml.replace(PROGRAM_ARGS, (_all, open: string, _body: string, close: string) => `${open}\n${words.map(w => `        <string>${xmlEscape(w)}</string>`).join("\n")}${close}`);
}

export type RouteResult = { ok: true; path: string } | { ok: false; reason: string };

/**
 * §6.2: install the route for an attempt (the caller holds the service lock and reloads the manager after). The unit's
 * bytes are kept as `unit.preimage` first (created once; a retry finds the same bytes).
 */
export function writeRecoveryRoute(home: string, attempt: AttemptRecord, deps: { plistArgs(xml: string): string[] | null }, io: JournalIo = defaultJournalIo): RouteResult {
  const service = identityOf(attempt)?.ownership.service;
  if (!service) return { ok: false, reason: "the attempt records no service to route through" };
  let bytes: Buffer;
  try { bytes = readFileSync(service.fragmentPath); }
  catch (err) { return { ok: false, reason: `the service definition ${service.fragmentPath} can't be read (${(err as Error).message})` }; }
  const pre = unitPreimagePath(home, attempt.id);
  let kept: Buffer | null = null;
  try { kept = readFileSync(pre); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, reason: `${pre} can't be read (${(err as Error).message})` }; }
  if (kept === null) {
    try { mkdirDurable(io, home, attemptDir(home, attempt.id)); writeDurable(pre, bytes, io); }
    catch (err) { return { ok: false, reason: `the unit's preimage can't be kept (${(err as Error).message})` }; }
  } else if (service.kind === "systemd" && !kept.equals(bytes)) {
    return { ok: false, reason: `the unit ${service.fragmentPath} changed since its preimage was kept` };
  }
  if (service.kind === "systemd") {
    const kit = kitDir(home, attempt.id);
    for (const p of [home, kit, handoffEnvPath(home, attempt.id)]) if (!unitSafe(p)) return { ok: false, reason: `${p} can't be written into a unit file as one plain word` };
    const path = dropInPath(service);
    try { mkdirDurable(io, dirname(dirname(path)), dirname(path)); writeDurable(path, dropInText(home, attempt.id), io, 0o644); }
    catch (err) { return { ok: false, reason: `the drop-in ${path} can't be written (${(err as Error).message})` }; }
    return { ok: true, path };
  }
  // launchd: wrap the ORIGINAL arguments — always read from the preimage's bytes, so a retry never wraps a wrapper.
  const source = (kept ?? bytes).toString("utf8");
  const original = deps.plistArgs(source);
  if (!original || original.length === 0) return { ok: false, reason: `the job's arguments in ${service.fragmentPath} can't be read` };
  const wrapped = wrapPlist(source, home, attempt.id, original);
  if (!wrapped) return { ok: false, reason: `${service.fragmentPath} has no single ProgramArguments array to wrap` };
  try { writeDurable(service.fragmentPath, wrapped, io, "keep"); }
  catch (err) { return { ok: false, reason: `${service.fragmentPath} can't be written (${(err as Error).message})` }; }
  return { ok: true, path: service.fragmentPath };
}

/**
 * §6.2 step 6: take the route off after the takeover is acknowledged. systemd: the drop-in removed (its directory
 * fsynced; the caller reloads). launchd: the preimage's bytes written back to disk (the loaded job keeps the wrapper
 * until its next load — harmless outside an attempt).
 */
export function removeRecoveryRoute(home: string, attempt: AttemptRecord, io: JournalIo = defaultJournalIo): RouteResult {
  const service = identityOf(attempt)?.ownership.service;
  if (!service) return { ok: false, reason: "the attempt records no service" };
  if (service.kind === "systemd") {
    const path = dropInPath(service);
    try { unlinkSync(path); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, reason: `${path} can't be removed (${(err as Error).message})` }; }
    try { io.fsyncDir(dirname(path)); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, reason: `${dirname(path)} can't be synced (${(err as Error).message})` }; }
    return { ok: true, path };
  }
  let kept: Buffer;
  try { kept = readFileSync(unitPreimagePath(home, attempt.id)); }
  catch (err) { return { ok: false, reason: `the unit's preimage can't be read (${(err as Error).message}); the wrapper stays` }; }
  try { writeDurable(service.fragmentPath, kept, io, "keep"); }
  catch (err) { return { ok: false, reason: `${service.fragmentPath} can't be written back (${(err as Error).message})` }; }
  return { ok: true, path: service.fragmentPath };
}

/**
 * The original arguments behind a recovery wrapper — only when the argument vector is EXACTLY this home's wrapper
 * (design §6.2, "P3 accepts the wrapper only when it is exactly this"):
 * - `/bin/sh -c WRAPPER_SCRIPT agend-update-recovery <kit>/node <kit>/recover.cjs <home> <id> …`, the script byte-for-byte;
 * - `<kit>` is this home's recovery directory for `<id>`, and that kit verifies (`verifyKit`: kit.json and both hashes);
 * - the attempt `<id>` itself is proven terminal from ITS OWN record (committed, rolled-back or abandoned — not
 *   manual-recovery), and no attempt is in flight now (`current` none or closing);
 * - the tail `…` is byte-for-byte the `ProgramArguments` of that attempt's `unit.preimage` (`plistArgs` parses it).
 * Anything else, or anything that can't be read: null — the caller reads it as an unknown service.
 */
export function unwrapRecoveryRoute(argv: string[], home: string, deps: { verifyKit(attemptId: string): boolean; plistArgs(xml: string): string[] | null },
  io: JournalIo = defaultJournalIo): string[] | null {
  if (argv.length < 9 || argv[0] !== "/bin/sh" || argv[1] !== "-c" || argv[2] !== WRAPPER_SCRIPT || argv[3] !== WRAPPER_ARG0) return null;
  const [kitNode, kitRecover, wrappedHome, id] = argv.slice(4, 8) as [string, string, string, string];
  if (wrappedHome !== home || !/^\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(id)) return null;
  const kit = kitDir(home, id);
  if (kitNode !== join(kit, "node") || kitRecover !== join(kit, "recover.cjs")) return null;
  if (!deps.verifyKit(id)) return null;
  const own = readAttemptRecord(home, id, io);
  if (!own || !TERMINAL.has(own.stage) || own.stage === "manual-recovery") return null;
  const read = readCurrent(home, io);
  if (read.state === "unknown" || read.state === "open" || read.state === "manual") return null;
  let preimage: string;
  try { preimage = readFileSync(unitPreimagePath(home, id), "utf8"); } catch { return null; }
  const original = deps.plistArgs(preimage);
  const tail = argv.slice(8);
  if (!original || original.length !== tail.length || original.some((w, i) => w !== tail[i])) return null;
  return tail;
}
