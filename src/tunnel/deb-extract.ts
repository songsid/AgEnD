/**
 * #1554: one file out of a Debian package, in Node, with no new dependency — for cloudflared's pkg.cloudflare.com
 * `.deb`, a fallback source when GitHub is slow. What comes out proves nothing by itself: the caller checks it
 * against the pinned SHA256 like every other download.
 *
 * Shapes accepted, as cloudflared 2026.9.3's packages have them: an `ar` archive (`!<arch>\n`, 60-byte headers,
 * decimal sizes, GNU names ending in `/`, members padded to an even offset) holding `data.tar.gz` — one gzip stream of
 * a POSIX/GNU tar (512-byte blocks, octal sizes, checksummed headers). Anything else — a truncated member, a bad
 * header, a link where the file should be, a compression other than gzip — is refused, never guessed at.
 */
import { gunzip } from "node:zlib";
import { promisify } from "node:util";

const gunzipAsync = promisify(gunzip);

export class DebExtractError extends Error {
  constructor(detail: string) { super(detail); this.name = "DebExtractError"; }
}

/** The bytes of the `ar` member named `wanted`. */
export function arMember(archive: Buffer, wanted: string): Buffer {
  if (archive.length < 8 || archive.toString("latin1", 0, 8) !== "!<arch>\n") throw new DebExtractError("not an ar archive");
  let offset = 8;
  while (offset < archive.length) {
    if (offset + 60 > archive.length) throw new DebExtractError("truncated ar header");
    const header = archive.toString("latin1", offset, offset + 60);
    if (header.slice(58, 60) !== "`\n") throw new DebExtractError("bad ar header");
    const sizeField = header.slice(48, 58).trim();
    if (!/^\d+$/.test(sizeField)) throw new DebExtractError("bad ar member size");
    const size = Number(sizeField);
    const start = offset + 60, end = start + size;
    if (end > archive.length) throw new DebExtractError("truncated ar member");
    const name = header.slice(0, 16).trim().replace(/\/$/, "");
    if (name === wanted) return archive.subarray(start, end);
    offset = end + (size % 2);
  }
  throw new DebExtractError(`no ${wanted} in the package`);
}

function octal(field: Buffer): number {
  const text = field.toString("latin1").replace(/\0.*$/s, "").trim();
  if (!/^[0-7]+$/.test(text)) throw new DebExtractError("bad tar number");
  return parseInt(text, 8);
}

/** The bytes of the regular file `path` (with or without a leading `./`) in a tar stream. */
export function tarFile(tar: Buffer, path: string): Buffer {
  const want = path.replace(/^\.\//, "");
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break; // the end-of-archive blocks
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
    if (octal(header.subarray(148, 156)) !== sum) throw new DebExtractError("bad tar header checksum");
    if (header[124] & 0x80) throw new DebExtractError("unsupported tar size encoding");
    const size = octal(header.subarray(124, 136));
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    // Only POSIX ustar ("ustar\0" "00") has a name prefix at 345; old GNU tar ("ustar  \0", these packages) keeps
    // other fields there.
    const prefix = header.toString("latin1", 257, 265) === "ustar\x0000" ? header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "") : "";
    const full = (prefix ? `${prefix}/${name}` : name).replace(/^\.\//, "");
    const type = String.fromCharCode(header[156]);
    const start = offset + 512, end = start + size;
    if (end > tar.length) throw new DebExtractError("truncated tar entry");
    if (full === want) {
      if (type !== "0" && type !== "\0") throw new DebExtractError(`${path} is not a regular file in the package`);
      return tar.subarray(start, end);
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  throw new DebExtractError(`no ${path} in the package`);
}

/** `usr/bin/cloudflared` out of a cloudflared `.deb`; `maxBytes` bounds the decompressed data. */
export async function extractDebFile(deb: Buffer, path: string, maxBytes: number): Promise<Buffer> {
  const data = arMember(deb, "data.tar.gz");
  let tar: Buffer;
  try {
    tar = await gunzipAsync(data, { maxOutputLength: maxBytes });
  } catch (err) {
    throw new DebExtractError(`data.tar.gz does not decompress: ${(err as Error).message}`);
  }
  return tarFile(tar, path);
}
