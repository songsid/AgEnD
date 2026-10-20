import { describe, expect, it } from 'vitest';
import { diagnosticLine, diagnosticRecord, redactDiagnostics, REDACTED } from '../src/diagnostic-redaction.js';

// Synthetic credentials only, constructed to avoid real tokens or scanning exceptions.
const cases: [string, string][] = [
  ['Telegram', '123456789:' + 'Abc_DEF-123'.repeat(4)],
  ['Discord', 'M'.repeat(24) + '.' + 'a'.repeat(6) + '.' + 'B'.repeat(30)],
  ['Discord MFA', 'mfa.' + 'C'.repeat(40)],
  ['OAuth access', 'ya29.' + 'accessXYZ'.repeat(5)],
  ['OAuth refresh', '1//' + 'refreshXYZ'.repeat(5)],
  ['OpenAI', 'sk-' + 'AbCd12'.repeat(7)],
  ['Anthropic', 'sk-ant-api03-' + 'AbCd12'.repeat(7)],
  ['GitHub classic', 'ghp_' + 'AbCd12'.repeat(7)],
  ['GitHub OAuth', 'gho_' + 'AbCd12'.repeat(7)],
  ['GitHub user', 'ghu_' + 'AbCd12'.repeat(7)],
  ['GitHub server', 'ghs_' + 'AbCd12'.repeat(7)],
  ['GitHub refresh', 'ghr_' + 'AbCd12'.repeat(7)],
  ['GitHub fine grained', 'github_pat_' + 'AbCd12'.repeat(7)],
  ['JWT', 'eyJhbGciOiJIUzI1NiJ9.' + 'eyJzdWIiOiJ1c2VyIn0' + '.abcdefghijk'],
  ['Google API', 'AIza' + 'AbCd12'.repeat(7)],
  ['AWS', 'AKIA' + 'AB12'.repeat(4)],
  ['AWS session', 'ASIA' + 'AB12'.repeat(4)],
  ['Slack', 'xoxb-' + '1234567-'.repeat(4) + 'abc'],
  ['npm', 'npm_' + 'AbCd12'.repeat(7)],
  ['GitLab', 'glpat-' + 'AbCd12'.repeat(7)],
  ['opaque unknown key', 'RandomOpaqueAccessCredential987654321'],
];
describe('shared diagnostic redaction', () => {
  it.each(cases)('removes %s in bare, JSON, URL-encoded and escaped representations', (_, secret) => {
    for (const input of [secret, `failure ${secret} end`, JSON.stringify({ error: secret }), encodeURIComponent(secret), secret.slice(0, 12) + '\x1b[31m' + secret.slice(12) + '\x1b[0m', [...secret].map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('')]) {
      const output = redactDiagnostics(input);
      expect(output).not.toContain(secret);
      expect(output).toContain(REDACTED);
      expect(redactDiagnostics(output)).toBe(output);
    }
  });
  it.each(['token', 'api_key', 'apiKey', 'client_secret', 'refresh_token', 'password', 'session_id', 'credentials', 'AWS_SECRET_ACCESS_KEY', 'client_secret_key', 'cookieJar', 'session'])('removes short, quoted multiline %s values', key => {
    for (const s of [`${key}=tiny`, `{"${key}":"tiny\\nsecret"}`, `${key}: 'tiny\nsecret'`]) {
      const result = redactDiagnostics(s); expect(result).not.toContain('tiny'); expect(result).not.toContain('secret\'');
    }
  });
  it('removes complete headers, folded cookies, PEM and URL credentials/query secrets', () => {
    const input = ['Authorization: Bearer tiny', 'Cookie: sid=tiny; other=more', ' folded-cookie=hidden', '-----BEGIN PRIVATE KEY-----', 'shortsecret', '-----END PRIVATE KEY-----', 'https://name:pw@private.test/callback?code=short'].join('\n');
    const output = redactDiagnostics(input);
    for (const word of ['tiny', 'more', 'hidden', 'shortsecret', 'name:pw', 'code=short']) expect(output).not.toContain(word);
  });
  it('hides personal identifiers by default; opt-in preserves identifiers but never secrets or chat IDs', () => {
    const identifiers = 'user@example.test 192.168.1.20 2001:db8::1 [fe80::1%eth0] myhost.lan /home/alice/repo C:\\Users\\alice\\repo';
    const output = redactDiagnostics(identifiers);
    for (const word of ['alice', 'example', '192.168', '2001:db8', 'fe80', 'myhost']) expect(output).not.toContain(word);
    const kept = redactDiagnostics(identifiers + ' token=tiny userId=123 topicId=42', { keepIdentifiers: true });
    expect(kept).toContain(identifiers); expect(kept).not.toContain('tiny'); expect(kept).not.toContain('userId=123'); expect(kept).not.toContain('topicId=42');
  });
  it('withholds arbitrary chat and nested unknown fields while retaining actual diagnostic evidence', () => {
    const output = diagnosticRecord({ time: 1, msg: 'chat says private phrase', text: 'secret chat', topicId: 42, userId: '123', nested: { note: 'hidden' }, err: { message: 'EAI_AGAIN for private phrase', stack: 'Error: private phrase\n at connect (/home/alice/project/file.js:12:4)' }, backend: 'codex', backendVersion: '1.2.3', attempt: 2 });
    for (const word of ['private phrase', 'secret chat', 'hidden', 'alice', 'topicId', 'userId']) expect(output).not.toContain(word);
    expect(output).toContain('EAI_AGAIN'); expect(output).toContain('1.2.3'); expect(output).toContain('codex'); expect(output).toContain('12:4');
    expect(diagnosticLine('Uncaught exception: Error: Opening handshake has timed out')).toContain('Opening handshake has timed out');
    expect(diagnosticLine('ordinary free-form user discussion')).toBeNull();
    expect(diagnosticLine('EXTERNAL_PRIVATE_NOTE ERR_MY_SECRET SIGPRIVATE')).toBeNull();
    expect(redactDiagnostics('2026-10-20T13:27:16.123Z ECONNRESET')).toBe('2026-10-20T13:27:16.123Z ECONNRESET');
  });
  it('removes whole credential objects/arrays and escaped short chat IDs', () => {
    const text = redactDiagnostics(JSON.stringify({ cookieJar: { session: 'tiny' }, access_token: ['short', 'hidden'], safe: { password: 'small' }, userId: 123, msg: 'chat' }));
    for (const word of ['tiny', 'short', 'hidden', 'small', '123', 'chat']) expect(text).not.toContain(word);
    expect(redactDiagnostics('instance_topic_id=42')).not.toContain('42');
    expect(redactDiagnostics(text)).toBe(text);
  });
  it('withholds nested credential containers and YAML blocks even in non-JSON error prose', () => {
    for (const text of ['failed: cookies: {"session":"tiny", "nested":["small"]} end', 'credentials: ["tiny", "small"]', 'api_key: |\n  tiny\n  small\nsafe: fine', 'failed: secret: {"incomplete":"tiny"']) {
      const safe = redactDiagnostics(text); expect(safe).not.toContain('tiny'); expect(safe).not.toContain('small'); expect(safe).toContain(REDACTED); expect(redactDiagnostics(safe)).toBe(safe);
    }
  });
  it('preserves ordinary bot stops/continues prose while removing provider bot credentials', () => {
    expect(redactDiagnostics('the bot stops answering')).toBe('the bot stops answering');
    expect(redactDiagnostics('the bot continues answering')).toBe('the bot continues answering');
    const secret = cases[0][1]; expect(redactDiagnostics('Bot ' + secret)).not.toContain(secret);
    expect(redactDiagnostics('Authorization: Bot tiny')).not.toContain('tiny');
  });
  it('redacts international email/hostnames and JSON host labels, with a deliberate identifier opt-in', () => {
    const input = '使用者@主機.台灣 主機.台灣';
    expect(redactDiagnostics(input)).toBe('[REDACTED] [REDACTED]');
    expect(redactDiagnostics(input, { keepIdentifiers: true })).toBe(input);
    const json = JSON.stringify({ host: 'workstation', email: 'person@example.test', username: 'alice', token: 'tiny' });
    const hidden = redactDiagnostics(json); expect(hidden).not.toContain('workstation'); expect(hidden).not.toContain('alice');
    const kept = redactDiagnostics(json, { keepIdentifiers: true }); expect(kept).toContain('workstation'); expect(kept).toContain('alice'); expect(kept).not.toContain('tiny');
  });
  it('handles bounded but adversarial long free-form lines without unbounded field/domain backtracking', () => {
    for (const text of ['a'.repeat(64 * 1024), '1.'.repeat(32 * 1024) + '1', 'a.'.repeat(32 * 1024) + 'z', 'x'.repeat(32 * 1024) + '@host.test']) {
      const safe = redactDiagnostics(text); expect(typeof safe).toBe('string'); expect(safe.length).toBeLessThanOrEqual(text.length * 2 + REDACTED.length);
    }
  });
  it('removes an opaque credential split into short pieces by terminal color codes', () => {
    const credential = ['AzByCxDw', 'EvFuGtHs', 'IrJqKpLo', 'MnNmOpPq'].join('');
    const colored = credential.slice(0, 16) + '\x1b[31m' + credential.slice(16) + '\x1b[0m';
    expect(redactDiagnostics(colored)).toBe(REDACTED);
  });
  it('preserves useful real AgEnD and Node stack locations through repeated whole-report redaction', () => {
    for (const path of ['/usr/lib/node_modules/@songsid/agend/dist/fleet-manager.js', '/home/alice/.nvm/versions/node/v22.23.3/lib/node_modules/@songsid/agend/dist/fleet-manager.js', 'C:\\Users\\alice\\node_modules\\@songsid\\agend\\dist\\fleet-manager.js']) {
      const result = diagnosticLine('    at FleetManager.start (' + path + ':120:7)');
      expect(result).toBe('at …/@songsid/agend/dist/fleet-manager.js:120:7'); expect(result).not.toContain('alice');
      expect(redactDiagnostics(result!)).toBe(result);
    }
    const dependency = diagnosticLine('at WebSocketShard.connect (/usr/lib/node_modules/@songsid/agend/node_modules/@discordjs/ws/dist/index.js:123:4)');
    expect(dependency).toBe('at …/@songsid/agend/node_modules/@discordjs/ws/dist/index.js:123:4');
    expect(redactDiagnostics(dependency!)).toBe(dependency);
    const internal = 'at node:internal/process/task_queues:95:5';
    expect(diagnosticLine(internal)).toBe(internal); expect(redactDiagnostics(internal)).toBe(internal);
    const secret = cases[4][1];
    expect(diagnosticLine('at fn (/usr/lib/node_modules/@songsid/agend/dist/' + secret + '.js:120:7)')).not.toContain(secret);
  });
  it('preserves filenames and abbreviations in titles/descriptions while still hiding hosts and credentials', () => {
    const prose = 'After editing fleet.yaml and daemon.log grew, e.g. agend crashed; see cli.js and i.e. notes.md';
    expect(redactDiagnostics(prose)).toBe(prose);
    expect(redactDiagnostics('crash after fleet.yaml edit')).toBe('crash after fleet.yaml edit');
    for (const host of ['machine.example.com', 'office.lan', 'workstation.internal']) expect(redactDiagnostics(host)).toBe(REDACTED);
    expect(redactDiagnostics('hostname=private.sh')).toBe(REDACTED);
    const token = cases[0][1]; expect(redactDiagnostics('fleet.yaml token=' + token)).not.toContain(token);
  });
  it('property: seeded generated known-shape secrets never survive wrappers (8400 checked cases)', () => {
    let state = 2256, checked = 0;
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
    for (let i = 0; i < 100; i++) {
      const noise = Array.from({ length: 40 }, () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'[random() % 63]).join('');
      const secrets = ['sk-' + noise, 'ya29.' + noise, '1//' + noise, 'ghp_' + noise, 'github_pat_' + noise, `${100000 + random()}:${noise}`, 'eyJhbGciOiJIUzI1NiJ9.' + noise + '.abcdefghijk'];
      for (const secret of secrets) for (const wrapper of [(s: string) => s, (s: string) => JSON.stringify({ token: s }), (s: string) => encodeURIComponent(s), (s: string) => s.slice(0, 12) + '\x1b[31m' + s.slice(12) + '\x1b[0m']) for (const context of ['prefix ', 'Error: ', '\n']) {
        const output = redactDiagnostics(context + wrapper(secret));
        expect(output).not.toContain(secret); expect(output).not.toContain(noise); expect(output).not.toMatch(/(?:sk-|ya29\.|ghp_|github_pat_|1\/\/)[A-Za-z0-9_]{8,}/);
        expect(redactDiagnostics(output)).toBe(output); checked++;
      }
    }
    expect(checked).toBe(8400);
  });
});
