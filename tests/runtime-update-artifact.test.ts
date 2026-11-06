import { createHash } from "node:crypto";
import { createServer, type RequestListener, type Server } from "node:http";
import { crc32 } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createRuntimeBundle, RUNTIME_MAX_ARCHIVE_BYTES } from "../src/runtime-bundle.js";
import { compareRuntimeVersions, fetchRuntimeUpdateArchive, fetchRuntimeUpdateMetadata, parseRuntimeUpdateMetadata,
  RUNTIME_UPDATE_ARCHIVE_PATH, RUNTIME_UPDATE_METADATA_PATH, RUNTIME_UPDATE_MAX_BYTES, runtimeUpdateEtag,
  runtimeUpdateNeeded, validateRuntimeUpdateArchive, type RuntimeUpdateMetadata } from "../src/runtime-update-artifact.js";
import { runtimeBundleFixture, unzipStored } from "./support/runtime-bundle-fixture.js";

const metadataFor = (bytes: Buffer, version = "2.3.5-alpha.7"): RuntimeUpdateMetadata => ({ version, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
let fixture: ReturnType<typeof runtimeBundleFixture>, bundle: ReturnType<typeof createRuntimeBundle>;
beforeAll(() => { fixture = runtimeBundleFixture("2.3.5-alpha.7"); bundle = createRuntimeBundle(fixture); });
afterAll(() => fixture?.cleanup());
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe("Runtime update artifact identity", () => {
  it("keeps the standalone download cap equal to the producer's existing bound", () => { expect(RUNTIME_UPDATE_MAX_BYTES).toBe(RUNTIME_MAX_ARCHIVE_BYTES); });
  it("accepts exactly the three bounded metadata fields", () => {
    const valid = metadataFor(Buffer.from("fixture"));
    expect(parseRuntimeUpdateMetadata(valid)).toEqual(valid);
    for (const value of [null, [], {}, { ...valid, url: "https://other.example.test" }, { ...valid, version: "../evil" }, { ...valid, version: "1.2.3-01" },
      { ...valid, version: "01.2.3" }, { ...valid, version: "1.2.3;cmd" }, { ...valid, sha256: "F".repeat(64) }, { ...valid, bytes: 0 },
      { ...valid, bytes: RUNTIME_UPDATE_MAX_BYTES + 1 }, { ...valid, bytes: 1.5 }, { ...valid, bytes: "10" }]) expect(() => parseRuntimeUpdateMetadata(value)).toThrow(/metadata/);
  });
  it("orders release/prerelease numeric identifiers and ignores build metadata", () => {
    const ordered = ["1.9.99", "2.0.0-alpha", "2.0.0-alpha.2", "2.0.0-alpha.10", "2.0.0-alpha.beta", "2.0.0-beta", "2.0.0", "2.0.1", "10.0.0"];
    for (let i = 1; i < ordered.length; i++) { expect(compareRuntimeVersions(ordered[i - 1], ordered[i])).toBe(-1); expect(compareRuntimeVersions(ordered[i], ordered[i - 1])).toBe(1); }
    expect(compareRuntimeVersions("1.2.3+one", "1.2.3+two")).toBe(0);
    expect(compareRuntimeVersions("1.2.3-alpha.1+one", "1.2.3-alpha.1+two")).toBe(0);
  });
  it("aligns a same-version changed build, refuses downgrades, and suppresses a failed target until the hash changes", () => {
    const target = metadataFor(Buffer.from("new")), current = { version: target.version, sha256: "a".repeat(64) };
    expect(runtimeUpdateNeeded(current, target)).toBe(true);
    expect(runtimeUpdateNeeded({ ...current, sha256: target.sha256 }, target)).toBe(false);
    expect(runtimeUpdateNeeded(current, target, target.sha256)).toBe(false);
    expect(runtimeUpdateNeeded(current, target, "b".repeat(64))).toBe(true);
    expect(() => runtimeUpdateNeeded({ ...current, version: "2.3.5" }, target)).toThrow(/downgrade/);
    expect(() => runtimeUpdateNeeded({ ...current, version: "2.3.6" }, target)).toThrow(/downgrade/);
  });
});

describe("paired-origin downloads over a real loopback fake server", () => {
  it("requests only the fixed paths, sends no credentials, and verifies the exact artifact", async () => {
    const expected = metadataFor(bundle.bytes), requests: string[] = [];
    const origin = await serve((req, res) => {
      requests.push(req.url!); expect(req.headers.authorization).toBeUndefined(); expect(req.headers.cookie).toBeUndefined();
      expect(req.headers["accept-encoding"]).toBe("identity");
      res.setHeader("ETag", runtimeUpdateEtag(expected));
      res.end(req.url === RUNTIME_UPDATE_METADATA_PATH ? JSON.stringify(expected) : bundle.bytes);
    });
    const metadata = await fetchRuntimeUpdateMetadata(origin);
    expect(metadata).toEqual(expected);
    const bytes = await fetchRuntimeUpdateArchive(origin, metadata);
    expect(bytes.equals(bundle.bytes)).toBe(true);
    expect(validateRuntimeUpdateArchive(bytes, metadata).metadata).toEqual(expected);
    expect(requests).toEqual([RUNTIME_UPDATE_METADATA_PATH, RUNTIME_UPDATE_ARCHIVE_PATH]);
  });
  it("refuses redirects without contacting another server", async () => {
    let otherHits = 0;
    const other = await serve((_req, res) => { otherHits++; res.end("forbidden"); });
    const origin = await serve((_req, res) => { res.writeHead(302, { Location: other + RUNTIME_UPDATE_ARCHIVE_PATH }); res.end(); });
    await expect(fetchRuntimeUpdateMetadata(origin)).rejects.toMatchObject({ reason: "transport" });
    await expect(fetchRuntimeUpdateArchive(origin, metadataFor(bundle.bytes))).rejects.toMatchObject({ reason: "transport" });
    expect(otherHits).toBe(0);
  });
  it("refuses non-origin or non-loopback HTTP inputs before sending", async () => {
    for (const origin of ["http://192.0.2.1", "https://fleet.example.test/alternate", "https://user:password@fleet.example.test", "https://fleet.example.test/?url=other", "file:///tmp/bundle"])
      await expect(fetchRuntimeUpdateMetadata(origin)).rejects.toMatchObject({ reason: "transport" });
  });
  it("refuses a changed artifact, mismatching ETag, short body and SHA mismatch", async () => {
    const expected = metadataFor(bundle.bytes);
    for (const variant of ["hash", "etag", "short"]) {
      const origin = await serve((_req, res) => {
        res.setHeader("ETag", variant === "etag" ? '"other"' : runtimeUpdateEtag(expected));
        const bytes = variant === "short" ? bundle.bytes.subarray(0, bundle.bytes.length - 1) : Buffer.from(bundle.bytes);
        if (variant === "hash") bytes[100] ^= 1;
        res.end(bytes);
      });
      await expect(fetchRuntimeUpdateArchive(origin, expected), variant).rejects.toMatchObject({ reason: "checksum" });
    }
  });
  it("bounds metadata and archive streams even without Content-Length", async () => {
    const origin = await serve((req, res) => { res.writeHead(200); res.write(Buffer.alloc(req.url === RUNTIME_UPDATE_METADATA_PATH ? 4097 : 33)); res.end(); });
    await expect(fetchRuntimeUpdateMetadata(origin)).rejects.toMatchObject({ reason: "download" });
    await expect(fetchRuntimeUpdateArchive(origin, metadataFor(Buffer.alloc(32)))).rejects.toMatchObject({ reason: "download" });
  });
  it("refuses an interrupted download and never returns its prefix", async () => {
    const expected = metadataFor(bundle.bytes);
    const origin = await serve((_req, res) => {
      res.writeHead(200, { "Content-Length": expected.bytes, ETag: runtimeUpdateEtag(expected) });
      res.flushHeaders(); res.write(bundle.bytes.subarray(0, 32)); setImmediate(() => res.destroy());
    });
    await expect(fetchRuntimeUpdateArchive(origin, expected)).rejects.toMatchObject({ reason: "download" });
  });
  it("rejects gzip, mismatching metadata ETags, extra URLs and a stalled response", async () => {
    const expected = metadataFor(bundle.bytes);
    for (const variant of ["encoding", "etag", "url"]) {
      const origin = await serve((_req, res) => {
        res.setHeader("ETag", variant === "etag" ? '"wrong"' : runtimeUpdateEtag(expected));
        if (variant === "encoding") res.setHeader("Content-Encoding", "gzip");
        res.end(JSON.stringify(variant === "url" ? { ...expected, url: "https://other.example.test" } : expected));
      });
      await expect(fetchRuntimeUpdateMetadata(origin)).rejects.toMatchObject({ reason: variant === "encoding" ? "transport" : "metadata" });
    }
    const stalled = await serve(() => {});
    await expect(fetchRuntimeUpdateMetadata(stalled, 30)).rejects.toMatchObject({ reason: "download" });
  });
});

/** Independent fixture writer uses Node's CRC implementation; it can describe deliberately hostile records. */
function repack(entries: Array<[string, Buffer]>, options: { flags?: number; method?: number; mode?: number } = {}): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [name, data] of entries) {
    const filename = Buffer.from("agend-runtime/" + name), crc = crc32(data), header = Buffer.alloc(30), record = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(options.flags ?? 0x0800, 6); header.writeUInt16LE(options.method ?? 0, 8);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x0314, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(options.flags ?? 0x0800, 8); record.writeUInt16LE(options.method ?? 0, 10);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE(((options.mode ?? 0o100644) << 16) >>> 0, 38); record.writeUInt32LE(offset, 42);
    local.push(header, filename, data); central.push(record, filename); offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
describe("stored ZIP code validation before any filesystem write", () => {
  it("accepts the real producer bundle and its exact package/code identity", () => {
    const metadata = metadataFor(bundle.bytes), value = validateRuntimeUpdateArchive(bundle.bytes, metadata), files = unzipStored(bundle.bytes);
    expect(value.buildId).toBe(JSON.parse(files.get("agend-runtime/bundle-manifest.json")!.toString()).buildId);
    expect(value.files.get("dist/runtime-cli.js")!.equals(files.get("agend-runtime/dist/runtime-cli.js")!)).toBe(true);
    const independent = repack([...value.files]); expect(validateRuntimeUpdateArchive(independent, metadataFor(independent)).buildId).toBe(value.buildId);
  });
  it("refuses an unverified archive before inspecting records", () => {
    const changed = Buffer.from(bundle.bytes); changed[50] ^= 1;
    expect(() => validateRuntimeUpdateArchive(changed, metadataFor(bundle.bytes))).toThrow(/checksum/);
  });
  it("refuses unsafe Windows paths, aliases, duplicate entries and file/directory collisions", () => {
    for (const name of ["../outside", "/absolute", "C:/outside", "dir\\outside", "dir/file:stream", "dir/NUL.txt", "dir/file.", "dir/./file", "dir//file", "x\0y"]) {
      const archive = repack([[name, Buffer.from("unsafe")]]);
      expect(() => validateRuntimeUpdateArchive(archive, metadataFor(archive)), name).toThrow(/archive/);
    }
    for (const names of [["file", "FILE"], ["file", "file"], ["dir", "dir/file"]]) {
      const archive = repack(names.map(n => [n, Buffer.from("unsafe")])); expect(() => validateRuntimeUpdateArchive(archive, metadataFor(archive))).toThrow(/archive/);
    }
  });
  it("refuses links, compressed/encrypted records and hidden/trailing data", () => {
    const entries = [...validateRuntimeUpdateArchive(bundle.bytes, metadataFor(bundle.bytes)).files];
    for (const options of [{ mode: 0o120777 }, { method: 8 }, { flags: 0x0801 }]) {
      const archive = repack(entries, options); expect(() => validateRuntimeUpdateArchive(archive, metadataFor(archive))).toThrow(/archive/);
    }
    const extra = Buffer.concat([bundle.bytes, Buffer.from("hidden")]); expect(() => validateRuntimeUpdateArchive(extra, metadataFor(extra))).toThrow(/archive/);
  });
  it("refuses changed code, package version, manifest build identity or file inventory even with a newly verified archive hash", () => {
    for (const variant of ["code", "package", "build", "inventory", "module", "origin"]) {
      const files = new Map(validateRuntimeUpdateArchive(bundle.bytes, metadataFor(bundle.bytes)).files), manifest = JSON.parse(files.get("bundle-manifest.json")!.toString());
      if (variant === "code") files.set("dist/runtime-cli.js", Buffer.from("throw Error('changed')"));
      if (variant === "package") files.set("package.json", Buffer.from(JSON.stringify({ ...JSON.parse(files.get("package.json")!.toString()), version: "0.0.1" })));
      if (variant === "build") manifest.buildId = "f".repeat(64);
      if (variant === "inventory") delete manifest.sha256["README.txt"];
      if (variant === "module") manifest.modules.push("../outside.js");
      if (variant === "origin") files.set("agend-server.json", Buffer.from('{"server":"https://other.example.test"}'));
      // Package/origin controls retain internally correct per-file checksums, so their specific boundary is exercised.
      if (variant === "package" || variant === "origin") for (const [name, bytes] of files) if (name !== "bundle-manifest.json") manifest.sha256[name] = createHash("sha256").update(bytes).digest("hex");
      files.set("bundle-manifest.json", Buffer.from(JSON.stringify(manifest)));
      const archive = repack([...files]); expect(() => validateRuntimeUpdateArchive(archive, metadataFor(archive)), variant).toThrow(/archive/);
    }
  });
});
