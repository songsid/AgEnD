/** The installer's generated program against real auth routes; no fleet or backend is constructed. */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { runInNewContext } from 'node:vm';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bypassesWebGate, handleAuthRequest } from '../src/auth-api.js';
import { decideWebGate } from '../src/web-auth.js';

const source = readFileSync('website/public/install-agend.ps1', 'utf8');
const section = source.slice(source.indexOf('function Test-InstallerReady'), source.indexOf('function Merge-InstallIni'));
const program = section.match(/\$js = '([^']+)'/)![1];
async function proof(status = 'ok', complete = true, page = true) {
  const requests: { path: string; method: string; credential: boolean }[] = [], warnings: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    requests.push({ path: url.pathname, method: req.method!, credential: !!(req.headers.cookie || req.headers['x-agend-token']) });
    if (!page && url.pathname === '/signin') { res.writeHead(503); res.end(); return; }
    if (!bypassesWebGate(req, url.pathname, null, () => false)) {
      const decision = decideWebGate(req, url, 'inert-fixture-token', null);
      if (decision.kind === 'reject') { res.writeHead(decision.status); res.end(decision.reason); return; }
    }
    if (handleAuthRequest(req, res, url, { fleetConfig: null } as unknown as Parameters<typeof handleAuthRequest>[3])) return;
    if (url.pathname === '/health') {
      res.writeHead(status === 'ok' ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status, startupComplete: complete, problems: status === 'degraded' ? ['memory pressure elevated'] : [] })); return;
    }
    res.writeHead(500); res.end('Unexpected route');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const state = { env: { AGEND_HOME: '/private-fixture' }, exitCode: 0 };
  try {
    const root = await fetch(`http://127.0.0.1:${port}/`); await root.text();
    requests.length = 0;
    await runInNewContext(program, {
      require: (name: string) => {
        if (name === 'path') return path;
        if (name === 'child_process') return { execFileSync: (bin: string, args: string[]) => { if (bin !== 'npm' || args.join(' ') !== 'root -g') throw Error('Native boundary forbidden'); return '/private-global'; } };
        if (name === 'module') return { createRequire: () => (name: string) => { if (name !== 'js-yaml') throw Error('Unexpected package'); return { load: () => ({ health_port: port }) }; } };
        if (name === 'fs') return { readFileSync: (file: string) => { if (file !== '/private-fixture/fleet.yaml') throw Error('Unexpected file'); return ''; } };
        throw Error('Unexpected module: ' + name);
      },
      process: state, fetch, AbortSignal,
      console: { log: (line: string) => warnings.push(line) },
      setTimeout: (fn: () => void) => setTimeout(fn, 1),
    });
    return { code: state.exitCode, rootStatus: root.status, rootPath: new URL(root.url).pathname, requests, warnings };
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

describe('installer readiness respects the dashboard auth boundary (#2704)', () => {
  it('a healthy fleet is ready through the public page while its dashboard stays protected', async () => {
    const result = await proof();
    expect(result.rootStatus).toBe(401); expect(result.rootPath).toBe('/ui');
    expect(result.code).toBe(0);
    expect(result.requests.map(x => x.path)).toEqual(['/health', '/signin']);
    expect(result.requests.every(x => x.method === 'GET' && !x.credential)).toBe(true);
  });
  it.each([['degraded', true, true, 0], ['down', true, true, 1], ['ok', false, true, 1], ['ok', true, false, 1]] as const)('preserves health/startup/page gates: %s/%s/%s', async (status, complete, page, code) => {
    const result = await proof(status, complete, page); expect(result.code).toBe(code);
    if (status === 'degraded') expect(result.warnings).toContain('AgEnD warning: memory pressure elevated');
    expect(result.requests.some(x => x.method !== 'GET' || x.credential || x.path === '/auth/issue-code')).toBe(false);
  });
});
