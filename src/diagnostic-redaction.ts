import { isIP } from "node:net";
import { stripVTControlCharacters } from "node:util";
import { constants as osConstants } from "node:os";
/** Public diagnostic export boundary. Never use a privacy opt-in to disable credentials. */
export const REDACTED = '[REDACTED]';
export interface RedactionOptions { keepIdentifiers?: boolean }

const credentialKey = /(?:token|secret|password|passwd|credential|authorization|cookie|api[_-]?key|private[_-]?key|session|^code$|^state$)/i;
const contentKey = /(?:^msg$|^host$|^ip$|message|content|prompt|text|body|conversation|transcript|topic|chat|user|sender|recipient|instance|channel|guild|email|hostname|address|url|path|argv|args)/i;
const personalKey = /^(?:emails?|ip(?:v[46])?(?:address)?|host(?:name)?|user[_-]?name|path)$/i;
const safeCodes = /\b(?:E[A-Z_]{3,30}|SIG[A-Z]{2,10}|ERR_[A-Z_]+)\b/g;
const knownCodes = new Set([...Object.keys(osConstants.errno), ...Object.keys(osConstants.signals),
  'EAI_AGAIN', 'EAI_NONAME', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_UNHANDLED_ERROR',
  'ERR_HTTP_HEADERS_SENT', 'ERR_SOCKET_CLOSED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_WORKER_OUT_OF_MEMORY',
  'ERR_MODULE_NOT_FOUND', 'ERR_REQUIRE_ESM', 'ERR_DLOPEN_FAILED', 'ERR_INVALID_STATE']);
const safePhrases = /Opening handshake has timed out|Connect Timeout Error|uncaught exception|unhandled rejection|gateway watchdog|MCP server died|web_terminal_created|adapter retry exhausted|out of memory|heap limit|allocation failed/gi;

/** Decode common wrappers before matching; don't preserve encoded copies of credentials. */
function decode(text: string): string {
  for (let pass = 0; pass < 4; pass++) {
    const previous = text;
    text = text.replace(/\\u([0-9a-f]{4})/gi, (_, n: string) => String.fromCharCode(parseInt(n, 16)))
      .replace(/\\x([0-9a-f]{2})/gi, (_, n: string) => String.fromCharCode(parseInt(n, 16)))
      .replace(/(?:%[0-9a-f]{2})+/gi, s => { try { return decodeURIComponent(s); } catch { return REDACTED; } });
    if (text === previous) break;
  }
  // Ambiguous deeply encoded data is withheld, not partially decoded and exported.
  return stripVTControlCharacters(text).replace(/(?:%[0-9a-f]{2})+/gi, REDACTED).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '');
}

/** A credential field can contain a whole object/list or YAML block, not just a string. */
function redactContainers(text: string): string {
  const fields = /["']?[\w.-]{0,128}(?:token|secret|password|passwd|credential|authorization|cookie|session|api[_-]?key|private[_-]?key)[\w.-]{0,128}["']?\s*[:=]\s*/gi;
  let cursor = 0, out = '', match: RegExpExecArray | null;
  while ((match = fields.exec(text))) {
    const start = fields.lastIndex, opener = text[start];
    if ((opener !== '{' && opener !== '[') || text.startsWith(REDACTED, start)) continue;
    const stack: string[] = [], pairs: Record<string, string> = { '{': '}', '[': ']' };
    let quote = '', escaped = false, end = text.length;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (quote) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (pairs[c]) stack.push(pairs[c]);
      else if (c === '}' || c === ']') {
        if (stack.pop() !== c) break; // malformed container: withhold the rest
        if (!stack.length) { end = i + 1; break; }
      }
    }
    out += text.slice(cursor, start) + REDACTED;
    cursor = end; fields.lastIndex = end;
  }
  text = out + text.slice(cursor);
  return text.replace(/^([ \t]*["']?[\w.-]{0,128}(?:token|secret|password|passwd|credential|cookie|api[_-]?key)[\w.-]{0,128}["']?\s*:\s*)[>|][-+]?[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/gmi, '$1' + REDACTED);
}

export function redactDiagnostics(input: string, options: RedactionOptions = {}): string {
  // Whole structured values (including nested cookie/token objects) cannot be redacted safely token by token.
  try {
    const parsed: unknown = JSON.parse(input);
    if (parsed && typeof parsed === 'object') {
      const scrub = (value: unknown, depth: number): unknown => {
        if (depth > 16) return REDACTED;
        if (typeof value === 'string') return redactDiagnostics(value, options);
        if (Array.isArray(value)) return value.map(v => scrub(v, depth + 1));
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) => [redactDiagnostics(key, options), credentialKey.test(key) || (contentKey.test(key) && !(options.keepIdentifiers && personalKey.test(key))) ? REDACTED : scrub(v, depth + 1)]));
        return value;
      };
      return JSON.stringify(scrub(parsed, 0));
    }
  } catch { /* Free-form diagnostic/description, handled below. */ }
  let text = redactContainers(decode(input));
  text = text.replace(/-----BEGIN [^-\r\n]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?(?:-----END [^-\r\n]+-----|$)/gi, REDACTED);
  // Entire header values, including folded continuation lines; not just Bearer tokens.
  text = text.replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/gi, REDACTED);
  // Quoted JSON/YAML/env/query credential values, including whitespace and multiline strings.
  text = text.replace(/(["']?[\w.-]{0,128}(?:tokens?|secrets?|passwords?|passwd|credentials?[\w.-]{0,128}|authorization|cookies?|api[_-]?key|private[_-]?key|session(?:[_-]?(?:key|id))?)[\w.-]{0,128}["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[REDACTED\]|[^\s,;&}\]\r\n]+)/gi, '$1' + REDACTED);
  text = text.replace(/\b(?:Bearer|Basic)\s+[^\s,;"'<>]+/gi, REDACTED)
    .replace(/\b(?:mfa\.[\w-]+|[\w-]{20,}\.[\w-]{6,}\.[\w-]{20,})\b/g, REDACTED)
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{15,}\b/g, REDACTED)
    .replace(/\b(?:ya29\.[\w.-]+|1\/\/[\w.-]+|sk-[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+|xox[baprs]-[\w-]+|AKIA[A-Z0-9]{12,}|ASIA[A-Z0-9]{12,}|AIza[\w-]{20,}|npm_[\w]+|glpat-[\w-]+)\b/g, REDACTED)
    .replace(/\beyJ[\w-]*\.[\w-]+\.[\w-]+\b/g, REDACTED)
    .replace(/\b[a-z][a-z\d+.-]{0,127}:\/\/[^\s<>"']+/gi, REDACTED);
  // Protect only recognized diagnostic locations/fields AFTER explicit credential rules.
  // Do not treat scoped npm paths as emails, long module names as opaque tokens, or
  // trusted line numbers/durations as chat IDs during the general privacy pass.
  const kept = new Map<string, string>();
  const keep = (value: string): string => { const marker = 'AGENDKEEP' + kept.size.toString(36) + 'Q'; kept.set(marker, value); return marker; };
  const safePath = (value: string): string => value.split(/[\\/]/).map(part => part.replace(/[A-Za-z0-9_+=]{24,}|\b\d{5,}\b/g, REDACTED)).join('/');
  text = text.replace(/(?:…+)?(?:[a-z]:[\\/]|\/)[^\r\n<>"()]{0,512}?@songsid[\\/]agend[\\/]((?:[@\w.-]+[\\/]){0,12}[\w.-]+\.(?:[cm]?js|ts)):(\d{1,7}):(\d{1,7})/gi,
    (_all, relative: string, line: string, column: string) => keep('…/@songsid/agend/' + safePath(relative) + ':' + line + ':' + column))
    .replace(/\bnode:([a-z_]+(?:\/[\w.-]+){0,12}):(\d{1,7}):(\d{1,7})/g,
      (_all, relative: string, line: string, column: string) => keep('node:' + safePath(relative) + ':' + line + ':' + column))
    .replace(/"(?:duration|durationMs|attempt|exitCode|statusCode)"\s*:\s*-?\d{1,24}(?:\.\d{1,12})?(?:e[+-]?\d{1,3})?/gi, keep);
  text = text
    // Opaque unknown keys and unlabelled IDs. Over-redaction is intentional.
    .replace(/[A-Za-z0-9_+/=-]{24,}/g, REDACTED)
    .replace(/\b\d{5,}\b/g, REDACTED)
    .replace(/[\"']?\b[\w.-]{0,128}(?:topic|chat|user|sender|recipient|instance|channel|guild)[_-]?id[\"']?\s*[=:]\s*(?:\[REDACTED\]|[^\s,;]+)/gi, REDACTED)
    .replace(/\b(?:message|content|prompt|chat[_-]?text)\s*[=:]\s*[^\r\n]*/gi, REDACTED);
  if (!options.keepIdentifiers) {
    text = text.replace(/[^\s@<>"'(),;\[\]\\/:]{1,320}@[^\s@<>"'(),;\[\]\\/:]{1,320}/gu, REDACTED)
      .replace(/(?:\b\d{1,3}\.){3}\d{1,3}\b/g, REDACTED)
      .replace(/\[?[a-f\d:.]{0,64}:[a-f\d:.]{1,64}(?:%[\w.-]{1,64})?\]?/gi, value => isIP(value.replace(/^\[|\]$/g, '').split('%')[0]) === 6 ? REDACTED : value)
      .replace(/(?<![\p{L}\p{N}_-])[\p{L}\p{N}-][\p{L}\p{N}.-]{0,252}\.[\p{L}][\p{L}\p{N}-]{0,62}(?![\p{L}\p{N}_-])/gu, value => /\.(?:ya?ml|json|log|[cm]?js|tsx?|md|txt|sh|ps1)$/i.test(value) || /^(?:e\.g|i\.e)$/i.test(value) ? value : REDACTED)
      .replace(/(\/(?:home|Users|mnt\/[a-z]\/Users)\/)[^\/\s]+/gi, '$1' + REDACTED)
      .replace(/([a-z]:\\Users\\)[^\\\s]+/gi, '$1' + REDACTED)
      .replace(/[\"']?\b(?:host(?:name)?|user(?:name)?)[\"']?\s*[=:]\s*(?:\[REDACTED\]|[^\s,;]+)/gi, REDACTED);
  }
  return text.replace(/AGENDKEEP[0-9a-z]+Q/g, value => kept.get(value) ?? value);
}

/** Log prose may itself be chat. Export only recognized diagnostics and stack locations. */
export function diagnosticLine(line: string, options: RedactionOptions = {}): string | null {
  const codes = [...new Set((line.match(safeCodes) ?? []).filter(code => knownCodes.has(code)))];
  const phrases = [...new Set(line.match(safePhrases) ?? [])];
  const stack = line.match(/^\s*at\s+(?:[\w.$<>]+\s+)?\(?((?:\/|[a-z]:\\|node:)[^\r\n]*?:\d+:\d+)\)?\s*$/i);
  if (stack) return redactDiagnostics('at ' + stack[1], options);
  const diagnostic = [...phrases, ...codes].join('; ');
  return diagnostic ? redactDiagnostics(diagnostic, options) : null;
}

/** Unknown and arbitrary string fields are deliberately omitted, even inside nested objects. */
export function diagnosticRecord(record: Record<string, unknown>, options: RedactionOptions = {}): string {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (credentialKey.test(key) || contentKey.test(key)) continue;
    if (/^(?:level|duration|durationMs|attempt|exitCode|statusCode)$/.test(key) && typeof value === 'number') out[key] = value;
    if (/^(?:backend|runtime)$/.test(key) && typeof value === 'string' && /^(?:claude-code|codex|kiro-cli|opencode|grok|muse|antigravity|node)$/.test(value)) out[key] = value;
    if (/^(?:version|cliVersion|backendVersion)$/.test(key) && typeof value === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[a-z]+\.\d{1,3})?$/.test(value)) out[key] = value;
    if (key === 'err' || key === 'error') {
      const error = value && typeof value === 'object' ? value as Record<string, unknown> : { message: value };
      const lines = Object.values(error).filter((s): s is string => typeof s === 'string').flatMap(s => s.split('\n'));
      out.error = lines.map(l => diagnosticLine(l, options)).filter(Boolean).join('\n') || '[Free-form error details withheld]';
    }
  }
  // msg is inspected for canonical diagnostics, never exported as raw prose.
  if (typeof record.msg === 'string') out.diagnostic = diagnosticLine(record.msg, options) ?? '[Free-form log text withheld]';
  return JSON.stringify(out);
}
