/**
 * M-3281: Settings → Web dashboard's "Archived chat files" card (settings-archive-files.js) — the size limit an admin raises
 * or lowers. Raising saves at once; lowering below what is kept asks first, naming how much of the oldest goes, and only
 * that confirmation sends the write (with `confirm_remove`); Cancel sends nothing. The fetch is a stub of the two routes.
 */
import { afterEach, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const mounted: AppPage[] = [];
afterEach(async () => { for (const pg of mounted.splice(0)) { await pg.unmount(); pg.restore(); } });
const until = async (test: () => unknown) => { for (let i = 0; i < 120 && !test(); i++) await settle(3); };
const GB = 1024 ** 3;

async function fixture(language: string, opts: { serverRefusesFirst?: boolean } = {}) {
  const pg = page({ url: "http://127.0.0.1:19280/settings/web-dashboard", storage: { agend_tour_done: "1" } }); mounted.push(pg);
  const calls: Array<{ path: string; method: string; body: any }> = [];
  let limit = 5, refused = false;
  (globalThis as any).fetch = async (path: string, options: any = {}) => {
    const method = options.method || "GET", body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, method, body });
    const answer = (status: number, json: unknown) => ({ ok: status < 300, status, json: async () => json });
    if (method === "GET" && path === "/api/settings/chat-archive") return answer(200, { ok: true, files_max_gb: limit, configured: limit !== 5, available: true, used_bytes: 3.4 * GB, files: 812 });
    if (method === "GET" && path.startsWith("/api/settings/chat-archive?gb=")) return answer(200, { ok: true, files_max_gb: limit, used_bytes: 3.4 * GB, files: 812,
      ...(opts.serverRefusesFirst ? { remove_bytes: 0, remove_files: 0 } : { remove_bytes: 1.2 * GB, remove_files: 230 }) });
    if (method === "PUT" && path === "/api/settings/fleet/web") {
      if (opts.serverRefusesFirst && !refused && !body.chat_archive.confirm_remove) { refused = true; return answer(409, { ok: false, error: "confirm_remove", remove_bytes: 0.3 * GB, remove_files: 40 }); }
      limit = body.chat_archive.files_max_gb;
      return answer(200, { ok: true, ...(body.chat_archive.confirm_remove ? { chat_archive_removed_files: 230 } : {}) });
    }
    return answer(404, { error: "not_found" });
  };
  const i18n = await import("/assets/app-i18n.js"); i18n.setLang(language, { store: false });
  const module = await import("/ui/js/settings-archive-files.js");
  await pg.mount(h(module.ArchiveFilesSetting, {})); await until(() => pg.root.querySelector("#webArchiveFilesGb"));
  const input = pg.root.querySelector("#webArchiveFilesGb") as any;
  const typeAndSave = async (v: string) => { input.value = v; fire(input, "input"); await settle(); fire(pg.root.querySelector("form")!, "submit"); await settle(6); };
  const dialogButton = (label: string) => [...pg.root.querySelectorAll("button")].find((b: any) => b.textContent.trim() === label) as any;
  return { pg, calls, input, typeAndSave, dialogButton, puts: () => calls.filter(c => c.method === "PUT") };
}

describe("the archived chat files' limit (Settings → Web dashboard)", () => {
  it.each([["en", "This removes about 1.2 GB of the oldest archived files (230 files).", "Remove and save", "Saved. 230 of the oldest files were removed."],
    ["zh-TW", "這會移除約 1.2 GB 最舊的封存檔案（230 個檔案）。", "移除並儲存", "已儲存。已移除 230 個最舊的檔案。"]])(
    "%s: lowering asks first with how much goes; only the confirmation sends the write (confirm_remove)", async (language, says, confirm, done) => {
      const f = await fixture(language);
      expect(f.input.value).toBe("5");
      expect(f.pg.root.textContent).toContain(language === "en" ? "Kept now: 3.4 GB in 812 files." : "目前保留：3.4 GB，共 812 個檔案。");
      await f.typeAndSave("2");
      await until(() => f.pg.root.textContent.includes(says));
      expect(f.pg.root.textContent).toContain(says);
      expect(f.puts(), "nothing saved (nor removed) before the confirmation").toEqual([]);
      expect(f.calls.map(c => c.path)).toContain("/api/settings/chat-archive?gb=2");
      fire(f.dialogButton(confirm), "click");
      await until(() => f.puts().length === 1 && f.pg.root.textContent.includes(done));
      expect(f.puts()[0]!.body).toEqual({ chat_archive: { files_max_gb: 2, confirm_remove: true } });
      expect(f.pg.root.textContent).toContain(done);
      expect(f.pg.root.textContent).not.toContain("archiveFiles.");
    });
  it("Cancel sends nothing", async () => {
    const f = await fixture("en");
    await f.typeAndSave("1");
    await until(() => f.dialogButton("Cancel"));
    fire(f.dialogButton("Cancel"), "click"); await settle(6);
    expect([f.puts(), f.pg.root.textContent.includes("This removes about")]).toEqual([[], false]);
  });
  it("raising saves at once, no question (and no estimate asked)", async () => {
    const f = await fixture("en");
    await f.typeAndSave("20");
    await until(() => f.puts().length === 1);
    expect([f.puts()[0]!.body, f.calls.some(c => c.path.includes("?gb="))]).toEqual([{ chat_archive: { files_max_gb: 20 } }, false]);
    await until(() => f.pg.root.textContent.includes("Saved."));
  });
  it("the server's refusal (more kept since the estimate) is asked about with the server's amount, then sent with the confirmation", async () => {
    const f = await fixture("en", { serverRefusesFirst: true });
    await f.typeAndSave("4.9");                                          // the estimate: nothing to remove; the server, at the write: 0.3 GB
    await until(() => f.pg.root.textContent.includes("This removes about 0.3 GB of the oldest archived files (40 files)."));
    expect(f.puts().map(p => p.body)).toEqual([{ chat_archive: { files_max_gb: 4.9 } }]);
    fire(f.dialogButton("Remove and save"), "click");
    await until(() => f.puts().length === 2);
    expect(f.puts()[1]!.body).toEqual({ chat_archive: { files_max_gb: 4.9, confirm_remove: true } });
  });
  it("out of range is refused on the page (nothing sent)", async () => {
    const g = await fixture("en");
    g.input.value = "-1"; fire(g.input, "input"); await settle();
    expect([(g.pg.root.querySelector("button[type=submit]") as any).disabled, g.pg.root.textContent.includes("Must be a number of GB from 0 to 100000"), g.puts()]).toEqual([true, true, []]);
  });
});
