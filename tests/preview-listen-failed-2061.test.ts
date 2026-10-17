/**
 * #2061 follow-up: when the HTML preview listener cannot open its port, the page is told why — `listenFailed` with
 * the port and the error — instead of `fleetOff` ("Previews are turned off for this fleet (web.preview: false)"),
 * which sent people looking for a setting nobody changed. Not listening (yet) is `notListening`; web.preview: false
 * is still `fleetOff`. A real port is held by another server here; nothing else on the host is touched.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";

const dirs: string[] = [], servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fleet(web: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "agend-2061-preview-")); dirs.push(dir);
  const fm = new FleetManager(dir);
  fm.logger = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child: () => fm.logger } as unknown as typeof fm.logger;
  const any = fm as unknown as Record<string, any>;
  any.fleetConfig = { instances: {}, web };
  return any;
}
const held = () => new Promise<number>((resolve) => {
  const s = createServer(); servers.push(s);
  s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
});
const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise(r => setTimeout(r, 10)); };

describe("a preview listener that cannot open its port (#2061 follow-up)", () => {
  it("a port another program holds: listenFailed, with the port and EADDRINUSE", async () => {
    const port = await held();
    const any = fleet({ preview_port: port });
    any.startPreviewListener(19280, 19280);
    await until(() => any.previewListener === null);
    const ui = any.previewForUi("127.0.0.1:19280", false);
    expect([ui.previewOrigin, ui.code, ui.detail]).toEqual([null, "listenFailed", `${port}: EADDRINUSE`]);
    expect(ui.reason).toContain(`${port}: EADDRINUSE`);
    expect(ui.reason).not.toMatch(/turned off/);
  });

  it("a port Node refuses at once (ERR_SOCKET_BAD_PORT): listenFailed too", () => {
    const any = fleet({ preview_port: 70000 });
    any.startPreviewListener(19280, 19280);
    expect(any.previewForUi("127.0.0.1:19280", false)).toMatchObject({ code: "listenFailed", detail: "70000: ERR_SOCKET_BAD_PORT" });
  });

  it("listening again clears it; not listening without an error is notListening; web.preview: false stays fleetOff", async () => {
    const any = fleet({});
    any.previewListenError = "19281: EADDRINUSE";
    const free = await held(); await new Promise<void>(r => servers.pop()!.close(() => r()));   // a port that is free now
    any.fleetConfig.web = { preview_port: free };
    any.startPreviewListener(19280, 19280);
    await until(() => any.previewListening === true);
    expect([any.previewListening, any.previewListenError]).toEqual([true, null]);
    expect(any.previewForUi("127.0.0.1:19280", false)).toMatchObject({ code: null, previewOrigin: `http://127.0.0.1:${free}` });
    any.stopPreviewListener();
    expect(any.previewForUi("127.0.0.1:19280", false)).toMatchObject({ code: "notListening", previewOrigin: null });
    any.fleetConfig.web = { preview: false };
    expect(any.previewForUi("127.0.0.1:19280", false)).toMatchObject({ code: "fleetOff" });
  });

  it("the public link with a configured preview_origin and no listener says the same", () => {
    const any = fleet({ preview_port: 70000, preview_origin: "https://preview.example.net" });
    any.startPreviewListener(19280, 19280);
    expect(any.publicPreviewForUi("exp-1", "https://abc.example.net")).toMatchObject({ code: "listenFailed", detail: "70000: ERR_SOCKET_BAD_PORT" });
  });
});
