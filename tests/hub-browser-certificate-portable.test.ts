/** A LibreSSL-style req config refusal in front of real local OpenSSL; no service or host config changes. */
import { afterEach, expect, it, vi } from "vitest";
import { X509Certificate } from "node:crypto";
import { dirname } from "node:path";
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { promisify } from "node:util";
import { tempDir } from "./support/hub-init-fixtures.js";

const probe = vi.hoisted(() => ({ configs: [] as { path: string; mode: number; args: readonly string[] }[], refuse: false }));
vi.mock("../src/child-process.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/child-process.js")>();
  const shim = () => { throw Error("unexpected callback invocation"); };
  Object.defineProperty(shim, promisify.custom, { value: async (file: string, args: readonly string[], options: object) => {
    const configFile = args[args.indexOf("-config") + 1];
    const config = configFile ? readFileSync(configFile, "utf8") : "";
    const dn = /^distinguished_name\s*=\s*(\w+)$/m.exec(config)?.[1];
    // Mac LibreSSL fails on /dev/null even with -subj: req still needs the named DN section.
    if (probe.refuse || !dn || !config.includes(`[${dn}]`)) throw Error("unable to find distinguished_name in config");
    probe.configs.push({ path: configFile!, mode: statSync(configFile!).mode & 0o777, args });
    return promisify(actual.execFile)(file, [...args], options);
  } });
  return { ...actual, execFile: shim as unknown as typeof actual.execFile };
});
import { createBrowserCertificate } from "../src/hub/init/browser-certificate.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); probe.configs.length = 0; probe.refuse = false; });
it.each(["https://127.0.0.1", "https://[::1]", "https://hub.example.test"])("generates %s with a private self-contained req config", async origin => {
  const home = tempDir("agend-browser-portable-"); homes.push(home);
  const generated = createBrowserCertificate(home, origin);
  await expect(generated).resolves.toHaveProperty("certFile");
  const material = await generated, cert = new X509Certificate(readFileSync(material.certFile));
  expect(probe.configs).toHaveLength(1);
  expect(probe.configs[0]!.mode).toBe(0o600);
  expect(dirname(probe.configs[0]!.path)).toBe(dirname(material.certFile));
  expect(probe.configs[0]!.args).not.toContain("-addext");
  expect(cert.ca).toBe(false); expect(cert.keyUsage).toEqual(["1.3.6.1.5.5.7.3.1"]);
  expect(readdirSync(dirname(material.certFile)).sort()).toEqual(["cert.pem", "key.pem", "material.json"]);
  material.cleanup(); expect(readdirSync(home)).toEqual([]);
});
it("cleans private staging when the req config is refused", async () => {
  const home = tempDir("agend-browser-portable-fail-"); homes.push(home); probe.refuse = true;
  await expect(createBrowserCertificate(home, "https://hub.example.test")).rejects.toThrow("browser_certificate_generation_failed");
  expect(readdirSync(home)).toEqual([]);
});
