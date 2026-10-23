#!/usr/bin/env node
/**
 * Fail if any GitHub Actions `uses:` in .github/workflows or .github/actions
 * is not pinned to a 40-char commit SHA. Local composite paths (`./…`) are
 * allowed; their own `uses:` are checked too. #2528
 *
 * Walks YAML mappings/sequences (block and flow) and records every mapping
 * whose key decodes to `uses`, including a value on the next indented line
 * and quoted keys with escapes (`"u\u0073es"`). Constructs this scanner
 * cannot take a value from fail closed.
 *
 * Zero-dep: the actions-pinned job does not npm ci.
 *
 *   node scripts/ci/assert-actions-pinned.mjs
 *   node scripts/ci/assert-actions-pinned.mjs --root <dir>
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const rootIdx = args.indexOf("--root");
const root = rootIdx >= 0 ? args[rootIdx + 1] : process.cwd();
const github = join(root, ".github");

const LOCAL = /^\.\//;
const PINNED = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$/;

function walk(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (name.endsWith(".yml") || name.endsWith(".yaml")) acc.push(p);
  }
  return acc;
}

function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inSingle && !inDouble) inSingle = true;
    else if (c === "'" && inSingle) {
      if (line[i + 1] === "'") i++;
      else inSingle = false;
    } else if (c === '"' && !inSingle && line[i - 1] !== "\\") inDouble = !inDouble;
    else if (c === "#" && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

function leadingSpaces(s) {
  let n = 0;
  while (n < s.length && s[n] === " ") n++;
  return n;
}

class YamlScanError extends Error {
  constructor(message, line) {
    super(message);
    this.line = line;
  }
}

function decodeDoubleQuoted(body) {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") {
      out += body[i];
      continue;
    }
    const n = body[++i];
    if (n === undefined) throw new Error("unterminated escape");
    if (n === "u") {
      const hex = body.slice(i + 1, i + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad \\u escape`);
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
      continue;
    }
    if (n === "U") {
      const hex = body.slice(i + 1, i + 9);
      if (!/^[0-9a-fA-F]{8}$/.test(hex)) throw new Error(`bad \\U escape`);
      out += String.fromCodePoint(parseInt(hex, 16));
      i += 8;
      continue;
    }
    if (n === "x") {
      const hex = body.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new Error(`bad \\x escape`);
      out += String.fromCharCode(parseInt(hex, 16));
      i += 2;
      continue;
    }
    const map = {
      n: "\n", t: "\t", r: "\r", b: "\b", f: "\f",
      "\\": "\\", '"': '"', "/": "/", " ": " ", "0": "\0",
    };
    if (Object.hasOwn(map, n)) out += map[n];
    else throw new Error(`unsupported escape \\${n}`);
  }
  return out;
}

function decodeSingleQuoted(body) {
  return body.replace(/''/g, "'");
}

function parseQuoted(s, i) {
  const q = s[i];
  if (q !== '"' && q !== "'") return null;
  if (q === "'") {
    let j = i + 1;
    let body = "";
    while (j < s.length) {
      if (s[j] === "'" && s[j + 1] === "'") {
        body += "'";
        j += 2;
        continue;
      }
      if (s[j] === "'") return { value: decodeSingleQuoted(body), end: j + 1, quoted: true };
      body += s[j++];
    }
    throw new Error("unterminated single quote");
  }
  let j = i + 1;
  let body = "";
  while (j < s.length) {
    if (s[j] === "\\" && j + 1 < s.length) {
      body += s[j] + s[j + 1];
      j += 2;
      continue;
    }
    if (s[j] === '"') return { value: decodeDoubleQuoted(body), end: j + 1, quoted: true };
    body += s[j++];
  }
  throw new Error("unterminated double quote");
}

function isKeyColonAt(s, colon) {
  return colon < s.length && s[colon] === ":" && (colon + 1 === s.length || s[colon + 1] === " " || s[colon + 1] === "#" || s[colon + 1] === "\t");
}

function parseKeyColon(s) {
  let i = 0;
  while (s[i] === " ") i++;
  const quoted = parseQuoted(s, i);
  if (quoted) {
    i = quoted.end;
    while (s[i] === " ") i++;
    if (!isKeyColonAt(s, i)) return null;
    return { key: quoted.value, rest: s.slice(i + 1), quoted: true };
  }
  const colon = s.indexOf(":", i);
  if (!isKeyColonAt(s, colon)) return null;
  const key = s.slice(i, colon).trim();
  if (!key || key.startsWith("-") || /[\{\[]/.test(key)) return null;
  return { key, rest: s.slice(colon + 1), quoted: false };
}

function looksLikeMappingLine(s) {
  try {
    return parseKeyColon(s) != null;
  } catch {
    return false;
  }
}

function parsePlain(s) {
  return s.trim();
}

function skipWs(s, i) {
  while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  return i;
}

function parseFlow(s, i, line, found) {
  i = skipWs(s, i);
  if (s[i] === "{") return parseFlowMap(s, i, line, found);
  if (s[i] === "[") return parseFlowSeq(s, i, line, found);
  const q = parseQuoted(s, i);
  if (q) return { value: q.value, end: q.end };
  let j = i;
  while (j < s.length && s[j] !== "," && s[j] !== "}" && s[j] !== "]" && s[j] !== "#") j++;
  return { value: s.slice(i, j).trim(), end: j };
}

function parseFlowMap(s, i, line, found) {
  i = skipWs(s, i);
  if (s[i] !== "{") throw new YamlScanError("expected {", line);
  i++;
  const obj = {};
  i = skipWs(s, i);
  if (s[i] === "}") return { value: obj, end: i + 1 };
  while (i < s.length) {
    i = skipWs(s, i);
    let key;
    const q = parseQuoted(s, i);
    if (q) {
      key = q.value;
      i = q.end;
    } else {
      let j = i;
      while (j < s.length && s[j] !== ":" && s[j] !== "," && s[j] !== "}") j++;
      key = s.slice(i, j).trim();
      i = j;
    }
    i = skipWs(s, i);
    if (s[i] !== ":") throw new YamlScanError("flow map missing :", line);
    i++;
    const val = parseFlow(s, i, line, found);
    if (key === "uses") found.push({ line, value: usesString(val.value) });
    obj[key] = val.value;
    i = skipWs(s, val.end);
    if (s[i] === ",") {
      i++;
      continue;
    }
    if (s[i] === "}") return { value: obj, end: i + 1 };
    throw new YamlScanError("unclosed flow map", line);
  }
  throw new YamlScanError("unclosed flow map", line);
}

function parseFlowSeq(s, i, line, found) {
  i = skipWs(s, i);
  if (s[i] !== "[") throw new YamlScanError("expected [", line);
  i++;
  const arr = [];
  i = skipWs(s, i);
  if (s[i] === "]") return { value: arr, end: i + 1 };
  while (i < s.length) {
    const val = parseFlow(s, i, line, found);
    arr.push(val.value);
    i = skipWs(s, val.end);
    if (s[i] === ",") {
      i++;
      continue;
    }
    if (s[i] === "]") return { value: arr, end: i + 1 };
    throw new YamlScanError("unclosed flow sequence", line);
  }
  throw new YamlScanError("unclosed flow sequence", line);
}

function usesString(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  return "";
}

function extractUses(text) {
  const found = [];
  const rawLines = text.split(/\r?\n/);
  let i = 0;

  const err = (msg, line = i + 1) => new YamlScanError(msg, line);
  const eof = () => i >= rawLines.length;
  const raw = () => rawLines[i] ?? "";
  const content = () => stripComment(raw());
  const indent = () => {
    const c = content();
    if (c.includes("\t")) throw err("tabs are unsupported");
    return leadingSpaces(c);
  };
  const isBlank = () => !content().trim();
  const skipBlank = () => {
    while (!eof() && isBlank()) i++;
  };
  const advance = () => {
    i++;
  };

  function parseInline(rest, line) {
    const t = rest.trim();
    if (!t) return null;
    if (t.startsWith("&") || t.startsWith("*") || t.startsWith("!!") || t === "<<") {
      throw err(`unsupported YAML form: ${t.slice(0, 24)}`, line);
    }
    if (t[0] === "{" || t[0] === "[") {
      const parsed = parseFlow(t, 0, line, found);
      const leftover = t.slice(parsed.end).trim();
      if (leftover && !leftover.startsWith("#")) throw err("trailing junk after flow value", line);
      return parsed.value;
    }
    if (/^[|>][+-]?\d*$/.test(t)) return { __block: t[0], line };
    const q = parseQuoted(t, 0);
    if (q && q.end === t.length) return q.value;
    if (q && stripComment(t.slice(q.end)).trim() === "") return q.value;
    return parsePlain(t);
  }

  function parseBlockScalar(parentIndent) {
    const start = i;
    advance();
    const chunks = [];
    let base = null;
    while (!eof()) {
      const line = raw();
      if (!line.trim()) {
        chunks.push("");
        advance();
        continue;
      }
      const sp = leadingSpaces(line);
      if (sp <= parentIndent) break;
      if (base == null) base = sp;
      chunks.push(line.slice(base));
      advance();
    }
    if (start === i) return "";
    return chunks.join("\n").replace(/\s+$/, "").trim();
  }

  function parseIndentedScalar(minIndent) {
    const parts = [];
    while (!eof()) {
      skipBlank();
      if (eof()) break;
      if (indent() < minIndent) break;
      const t = content().trimStart();
      if (t.startsWith("- ") || t === "-") break;
      if (looksLikeMappingLine(t)) break;
      parts.push(content().trim());
      advance();
    }
    return parts.join(" ").trim();
  }

  function recordUses(key, value, line) {
    if (key !== "uses") return;
    if (value && typeof value === "object" && value.__block) {
      found.push({ line, value: "", unsupported: true, raw: "multiline uses value is unsupported" });
      return;
    }
    if (value != null && typeof value !== "string") {
      found.push({ line, value: "", unsupported: true, raw: "uses value is not a string" });
      return;
    }
    found.push({ line, value: usesString(value) });
  }

  function parseMapping(mapIndent) {
    const obj = {};
    while (true) {
      skipBlank();
      if (eof()) break;
      const ind = indent();
      if (ind < mapIndent) break;
      if (ind > mapIndent) throw err("bad indentation");
      const t = content().trimStart();
      if (t.startsWith("- ") || t === "-") break;
      const pair = parseKeyColon(t);
      if (!pair) throw err(`unsupported mapping line: ${t.slice(0, 48)}`);
      const line = i + 1;
      let value;
      if (!pair.rest.trim()) {
        const keyIndent = ind;
        advance();
        skipBlank();
        if (eof() || indent() <= keyIndent) value = null;
        else {
          const child = indent();
          const ct = content().trimStart();
          if (ct.startsWith("- ") || ct === "-") value = parseSequence(child);
          else if (ct.startsWith("{") || ct.startsWith("[")) {
            value = parseInline(ct, i + 1);
            advance();
          } else if (looksLikeMappingLine(ct)) value = parseMapping(child);
          else value = parseIndentedScalar(child);
        }
      } else {
        value = parseInline(pair.rest, line);
        if (value && typeof value === "object" && value.__block) {
          value = parseBlockScalar(ind);
        } else {
          advance();
        }
      }
      recordUses(pair.key, value, line);
      obj[pair.key] = value;
    }
    return obj;
  }

  function parseSequence(seqIndent) {
    const arr = [];
    while (true) {
      skipBlank();
      if (eof()) break;
      if (indent() !== seqIndent) break;
      const t = content().trimStart();
      if (!(t === "-" || t.startsWith("- "))) break;
      const after = t === "-" ? "" : t.slice(2);
      const line = i + 1;
      const keyCol = seqIndent + 2;
      if (!after.trim()) {
        advance();
        skipBlank();
        arr.push(eof() || indent() <= seqIndent ? null : parseNode(indent()));
      } else if (looksLikeMappingLine(after)) {
        const pair = parseKeyColon(after);
        let value;
        if (!pair.rest.trim()) {
          advance();
          skipBlank();
          if (eof() || indent() <= seqIndent) value = null;
          else {
            const child = indent();
            const ct = content().trimStart();
            if (ct.startsWith("- ") || ct === "-") value = parseSequence(child);
            else if (looksLikeMappingLine(ct)) value = parseMapping(child);
            else value = parseIndentedScalar(child);
          }
        } else {
          value = parseInline(pair.rest, line);
          if (value && typeof value === "object" && value.__block) {
            value = parseBlockScalar(seqIndent);
          } else {
            advance();
          }
        }
        recordUses(pair.key, value, line);
        const obj = { [pair.key]: value };
        Object.assign(obj, parseMapping(keyCol));
        arr.push(obj);
      } else {
        arr.push(parseInline(after, line));
        advance();
      }
    }
    return arr;
  }

  function parseNode(minIndent) {
    skipBlank();
    if (eof()) return null;
    const ind = indent();
    if (ind < minIndent) return null;
    const t = content().trimStart();
    if (t.startsWith("- ") || t === "-") return parseSequence(ind);
    if (t.startsWith("{") || t.startsWith("[")) {
      const v = parseInline(t, i + 1);
      advance();
      return v;
    }
    if (looksLikeMappingLine(t)) return parseMapping(ind);
    return parseIndentedScalar(ind);
  }

  try {
    skipBlank();
    if (!eof() && content().trim() === "---") advance();
    skipBlank();
    if (!eof()) parseNode(indent());
    skipBlank();
    if (!eof() && content().trim() === "...") advance();
    skipBlank();
    if (!eof()) throw err("unsupported extra YAML content");
  } catch (e) {
    const line = e instanceof YamlScanError ? e.line : i + 1;
    found.push({ line, value: "", unsupported: true, raw: e.message || String(e) });
  }
  return found;
}

export { extractUses };

function main() {
  const files = walk(join(github, "workflows")).concat(walk(join(github, "actions")));
  if (files.length === 0) {
    console.error(`no workflow/action yaml under ${relative(process.cwd(), github) || ".github"}`);
    process.exit(2);
  }

  const unpinned = [];
  for (const file of files) {
    const rel = relative(root, file);
    const found = extractUses(readFileSync(file, "utf8"));
    for (const hit of found) {
      if (hit.unsupported) {
        unpinned.push(`${rel}:${hit.line}: unsupported uses form: ${hit.raw}`);
        continue;
      }
      const value = hit.value;
      if (!value) {
        unpinned.push(`${rel}:${hit.line}: empty uses`);
        continue;
      }
      if (LOCAL.test(value)) continue;
      if (PINNED.test(value)) continue;
      unpinned.push(`${rel}:${hit.line}: ${value}`);
    }
  }

  if (unpinned.length > 0) {
    console.error("Unpinned GitHub Actions `uses:` (need owner/repo@<40-char-sha> # tag):");
    for (const row of unpinned) console.error(`  ${row}`);
    process.exit(1);
  }

  console.log(`ok: ${files.length} files, every remote uses: is a 40-char SHA`);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) main();
