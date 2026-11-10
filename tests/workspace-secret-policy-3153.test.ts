import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isHiddenPath, workspaceChanges, workspaceFile, workspaceFileDiff, workspaceImage, workspaceList,
  workspaceRoot, type WorkspaceRoot } from "../src/agent-workspace.js";
import { resolveFollowSteps } from "../src/workspace-follow.js";

const missed = [".envLOCAL", "id_custom", "mycredentials.json", "mysecret.txt"];
const denied = [
  ...missed, ".ENVLOCAL", ".environment", ".envExample.txt", "ID_CUSTOM", "id_newtype.pub",
  "myCREDENTIALS.json", "appCredentialStore.json", "MYSECRET.TXT", "secretary.md", "myPASSWORD.txt",
  "somePrivateKey.txt", "somePRIVATE-KEY.txt", "somePrivate_Key.txt", "server.KEY", "server.PEM",
  "prod.env", "state.tfstate.backup", "serviceAccount-prod.json", ".bash_history", ".npmrc", ".GIT",
  "server.key.old", "server.PEM_saved", ".npmrc.bak", "auth.json.saved", ".claude.json", ".git_backup", "kubeconfigPROD",
];
const ordinary = ["app.ts", "README.md", "identity.ts", "environment.ts", "keyboard.ts", "tokens.css",
  "package.json", "server.crt", "history.md", ".editorconfig", "config/settings.json", "docs/security.md",
  ".gitignore", ".gitattributes", ".github/workflows/ci.yml", "file.keywords.txt"];

describe("one conservative Files/Changes and Follow filename policy (#3153/#3160)", () => {
  it.each(denied.flatMap(name => [name, `src/${name}`, `src/${name}/ordinary.txt`]))("hides %s, including a secret-looking ancestor", path => {
    expect(isHiddenPath(path)).toBe(true);
  });
  it.each(ordinary)("keeps ordinary %s visible", path => {
    expect(isHiddenPath(path)).toBe(false);
  });
  it("keeps the workspace root visible", () => { expect(isHiddenPath("")).toBe(false); });
  it.each(["odd\\name.txt", "odd\nname.txt", "odd\u007fname.txt"])("fails closed for an ambiguous path spelling %j", path => {
    expect(isHiddenPath(path)).toBe(true);
  });
});

let base: string, root: string, ws: WorkspaceRoot;
const canary = (name: string, kind: string) => `PRIVATE_CANARY_${missed.indexOf(name)}_${kind}`;
const save = (path: string, text: string | Buffer) => {
  const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text);
};
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { env: { ...process.env,
  GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" } });
beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "agend-secret-policy-")); root = join(base, "work"); mkdirSync(root);
  git("init", "-q", "-b", "main");
  for (const name of missed) save(name, "before\n");
  save("app.ts", "before\n"); save("auth.json", "before\n"); git("add", "."); git("commit", "-qm", "owned fixture");
  save("auth.json", "KNOWN_PRIVATE_CANARY\n");
  for (const name of missed) {
    save(name, `${canary(name, "tracked")}\n`);
    save(`untracked/${name}`, `${canary(name, "untracked")}\n`);
    save(`folders/${name}/ordinary.txt`, `${canary(name, "ancestor")}\n`);
    save(`folders/${name}/picture.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    save(`${name}.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  }
  save("app.ts", "VISIBLE_CONTROL\n"); save("untracked/notes.md", "VISIBLE_NOTES\n");
  save("picture.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  ws = await workspaceRoot(root, join(base, "state"));
});
afterAll(() => { if (base) rmSync(base, { recursive: true, force: true }); });

describe("every workspace reader and listing uses the filename policy", () => {
  it("hidden tracked files do not expose content-derived line counts", async () => {
    const changes = await workspaceChanges(ws);
    expect(changes.files.find(f => f.path === "auth.json")).toMatchObject({ hidden: true, adds: null, dels: null, binary: false });
    expect(JSON.stringify(changes)).not.toContain("KNOWN_PRIVATE_CANARY");
  });
  it.each(missed)("%s: tracked/untracked listings and patches omit contents", async name => {
    const listing = await workspaceList(ws, ""), nested = await workspaceList(ws, "untracked");
    expect(listing.entries.find(e => e.name === name)).toMatchObject({ hidden: true });
    expect(nested.entries.find(e => e.name === name)).toMatchObject({ hidden: true });
    const changes = await workspaceChanges(ws);
    expect(changes.files.find(f => f.path === name)).toMatchObject({ hidden: true, untracked: false });
    expect(changes.files.find(f => f.path === `untracked/${name}`)).toMatchObject({ hidden: true, untracked: true });
    expect(JSON.stringify(changes)).not.toContain(canary(name, "tracked"));
    expect(JSON.stringify(changes)).not.toContain(canary(name, "untracked"));
    expect(JSON.stringify(changes)).not.toContain(canary(name, "ancestor"));
    expect(changes.patch).toContain("+VISIBLE_CONTROL"); expect(changes.patch).toContain("+VISIBLE_NOTES");
  });
  it.each(missed)("%s: direct text, image and diff requests are refused", async name => {
    for (const path of [name, `untracked/${name}`, `folders/${name}/ordinary.txt`]) {
      await expect(workspaceFile(ws, path)).rejects.toMatchObject({ code: "hidden" });
      await expect(workspaceFileDiff(ws, path)).rejects.toMatchObject({ code: "hidden" });
    }
    await expect(workspaceList(ws, `folders/${name}`)).rejects.toMatchObject({ code: "hidden" });
    await expect(workspaceImage(ws, `folders/${name}/picture.png`)).rejects.toMatchObject({ code: "hidden" });
    await expect(workspaceImage(ws, `${name}.png`)).rejects.toMatchObject({ code: "hidden" });
  });
  it.each(missed)("%s: Follow marks the same files and ancestors hidden", async name => {
    const paths = [name, `untracked/${name}`, `folders/${name}/ordinary.txt`];
    const steps = await resolveFollowSteps(ws, [{ seq: 1, at: 1, kind: "read", tool: "Read", exact: true, paths }]);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.paths).toEqual(paths.map(path => ({ path, hidden: true, dir: false })));
    expect(JSON.stringify(steps)).not.toContain("PRIVATE_CANARY");
  });
  it("ordinary text, image, diff, directory and Follow remain usable", async () => {
    expect(await workspaceFile(ws, "app.ts")).toMatchObject({ kind: "text", text: "VISIBLE_CONTROL\n" });
    expect((await workspaceImage(ws, "picture.png")).bytes).toHaveLength(8);
    expect((await workspaceFileDiff(ws, "app.ts")).patch).toContain("+VISIBLE_CONTROL");
    expect((await workspaceList(ws, "untracked")).entries.find(e => e.name === "notes.md")).toMatchObject({ hidden: false });
    const steps = await resolveFollowSteps(ws, [{ seq: 1, at: 1, kind: "read", tool: "Read", exact: true, paths: ["app.ts"] }]);
    expect(steps[0]!.paths).toEqual([{ path: "app.ts", hidden: false, dir: false }]);
  });
});
