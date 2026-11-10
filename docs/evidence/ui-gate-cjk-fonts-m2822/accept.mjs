// Local acceptance only: original loopback UI fixture, no fleet start or remote directory.
import assert from 'node:assert/strict';
import { spawnSync, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { once } from 'node:events';

if (process.argv[2] === 'held-tls-peer') {
  const { createServer } = await import('node:net');
  const sockets = new Set();
  const peer = createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  peer.listen(0, '127.0.0.1', () => process.send(peer.address().port));
  process.on('message', () => { for (const socket of sockets) socket.destroy(); peer.close(() => process.exit(0)); });
} else {
  const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  const control = resolve(process.env.CONTROL_REPO ?? join(repo, '../ui-gate-cjk-control-m2822'));
  const out = resolve(process.env.OUT ?? join(repo, '.artifacts/acceptance'));
  mkdirSync(out, { recursive: true });
  const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  const run = (command, args, cwd = repo, env = process.env, timeout = 180_000) => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, `${command}: ${result.error ?? result.stderr ?? result.signal}`);
    return result.stdout;
  };
  const git = (cwd, ...args) => run('git', args, cwd).trim();
  assert.equal(git(control, 'rev-parse', 'HEAD'), 'bbff8ae42aeab2371b7d6de9b89948ec76a36d59');
  const protectedPaths = ['src', 'scripts/manual/smoke', 'scripts/manual/smoke-fixture'];
  const source = {};
  for (const [name, cwd] of [['control', control], ['candidate', repo]]) {
    assert.equal(git(cwd, 'status', '--porcelain', '--', ...protectedPaths, 'scripts/ci', '.github/workflows/ci.yml'), '');
    source[name] = { head: git(cwd, 'rev-parse', 'HEAD'), tree: git(cwd, 'rev-parse', 'HEAD^{tree}'), inputs: Object.fromEntries(protectedPaths.map(path => [path, git(cwd, 'rev-parse', `HEAD:${path}`)])) };
  }
  assert.deepEqual(source.control.inputs, source.candidate.inputs);
  const pin = JSON.parse(readFileSync(join(repo, 'scripts/ci/ui-gate-fonts.json'), 'utf8'));
  const env = { ...process.env, XDG_CONFIG_HOME: join(out, 'xdg-config'), XDG_DATA_HOME: join(out, 'xdg-data') };
  mkdirSync(env.XDG_CONFIG_HOME); mkdirSync(env.XDG_DATA_HOME);
  const cache = join(out, 'cache');
  const helper = join(repo, 'scripts/ci/prepare-ui-gate-fonts.mjs');
  const prepare = (label, processEnv) => {
    const started = Date.now(), output = join(out, label);
    const log = run(process.execPath, [helper, '--cache-dir', cache, '--output-dir', output], repo, processEnv);
    writeFileSync(join(out, label + '.log'), log);
    const receipt = JSON.parse(readFileSync(join(output, 'receipt.json'), 'utf8'));
    return { ...receipt, elapsedMs: Date.now() - started };
  };
  const cold = prepare('cold', env); assert.equal(cold.source, 'download');
  const offlineBin = join(out, 'offline-bin'); mkdirSync(offlineBin);
  writeFileSync(join(offlineBin, 'curl'), '#!/bin/sh\necho unexpected-curl >&2\nexit 97\n', { mode: 0o755 });
  const warm = prepare('warm', { ...env, PATH: offlineBin + ':' + process.env.PATH }); assert.equal(warm.source, 'cache');

  const peer = fork(fileURLToPath(import.meta.url), ['held-tls-peer'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const [port] = await once(peer, 'message');
  let failure;
  try {
    const { prepareUiGateFonts } = await import(helper);
    const started = Date.now();
    const failEnv = { ...env, HTTPS_PROXY: '', HTTP_PROXY: '', ALL_PROXY: '', https_proxy: '', http_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1' };
    assert.throws(() => prepareUiGateFonts({ cacheDir: join(out, 'failure-cache'), outputDir: join(out, 'failure-fonts'), pin: { ...pin, url: `https://127.0.0.1:${port}/held.deb` }, env: failEnv, log: line => writeFileSync(join(out, 'failure.log'), line + '\n', { flag: 'a' }) }), error => {
      writeFileSync(join(out, 'failure.log'), error.message + '\n', { flag: 'a' });
      return /CJK fonts download failed/.test(error.message) && /timed out|Timeout/i.test(error.message);
    });
    failure = { elapsedMs: Date.now() - started, cacheEmpty: readdirSync(join(out, 'failure-cache')).length === 0, noOutput: !existsSync(join(out, 'failure-fonts')) };
    assert.ok(failure.elapsedMs < 15_000 && failure.cacheEmpty && failure.noOutput);
  } finally {
    const closed = once(peer, 'exit'); peer.send('close'); await closed;
  }

  // Reconstruct the old apt-installed configuration, including the package's 70-* rule
  // at its normal sorted position, entirely under the owned output directory.
  const baseline = join(out, 'apt-control'); mkdirSync(baseline);
  run('dpkg-deb', ['--extract', join(cache, pin.archive), baseline]);
  const confDir = join(baseline, 'conf.d'); mkdirSync(confDir);
  for (const name of readdirSync('/etc/fonts/conf.d').filter(name => /^\d.*\.conf$/.test(name))) {
    copyFileSync(join('/etc/fonts/conf.d', name), join(confDir, name));
  }
  copyFileSync(join(baseline, pin.fontconfigRule.path), join(confDir, '70-fonts-noto-cjk.conf'));
  const xml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const baselineCfg = readFileSync('/etc/fonts/fonts.conf', 'utf8').replace('>conf.d</include>', `>${xml(confDir)}</include>`)
    .replace('</fontconfig>', `<dir>${xml(join(baseline, 'usr/share/fonts/opentype/noto'))}</dir><cachedir>${xml(join(baseline, 'font-cache'))}</cachedir></fontconfig>`);
  const baselineFile = join(baseline, 'fonts.conf'); writeFileSync(baselineFile, baselineCfg);
  run('fc-cache', ['--force', join(baseline, 'usr/share/fonts/opentype/noto')], repo, { ...env, FONTCONFIG_FILE: baselineFile });
  const pwDir = resolve(process.env.PW_DIR);
  const chrome = resolve(process.env.CHROME);
  const pw = createRequire(join(pwDir, 'package.json'))('playwright-core');
  const samples = ['允許的群組與人員', '儲存後不會再顯示', 'AD 連線設定：服務帳號、憑證與安全通知', 'Hub Settings 123 — 臺灣體驗'];
  const glyphs = {};
  const results = {};
  for (const [name, cwd, config, port] of [['control', control, baselineFile, 47820], ['candidate', repo, warm.fontconfig, 47830]]) {
    const processEnv = { ...env, FONTCONFIG_FILE: config };
    const browser = await pw.chromium.launch({ executablePath: chrome, args: ['--no-sandbox'], env: processEnv });
    try {
      const page = await browser.newPage({ locale: 'zh-TW' });
      glyphs[name] = await page.evaluate(async texts => {
        document.documentElement.lang = 'zh-TW'; await document.fonts.ready;
        const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
        const metrics = [];
        for (const family of ['system-ui, sans-serif', '"Noto Sans CJK TC", sans-serif']) for (const weight of [400, 700]) for (const size of [16, 20]) for (const text of texts) {
          context.font = `${weight} ${size}px ${family}`;
          const el = document.createElement('span'); el.textContent = text;
          Object.assign(el.style, { fontFamily: family, fontWeight: String(weight), fontSize: `${size}px`, display: 'inline-block', whiteSpace: 'nowrap' }); document.body.appendChild(el);
          const box = el.getBoundingClientRect();
          metrics.push({ family, weight, size, text, canvas: context.measureText(text).width, width: box.width, height: box.height }); el.remove();
        }
        return metrics;
      }, samples);
    } finally { await browser.close(); }
    const gateOut = join(out, 'gate-' + name);
    const gateEnv = { ...processEnv, REPO: cwd, PW_DIR: pwDir, CHROME: chrome, GATE: 'ci', GATE_PORT: String(port), OUT: gateOut, TMPDIR: resolve(repo, '../../.artifacts/t2822'), PATH: join(repo, '.artifacts/deny-bin') + ':' + process.env.PATH };
    const log = run(process.execPath, [join(repo, 'node_modules/tsx/dist/cli.mjs'), 'scripts/manual/smoke/smoke-settings-ui-gate.mts'], cwd, gateEnv);
    writeFileSync(join(out, 'gate-' + name + '.log'), log);
    const result = JSON.parse(readFileSync(join(gateOut, 'smoke-settings-ui-gate/result.json'), 'utf8'));
    delete result.seconds; results[name] = result;
  }
  assert.deepEqual(glyphs.candidate, glyphs.control);
  assert.deepEqual(results.candidate, results.control);
  for (const result of Object.values(results)) assert.equal(Object.values(result).filter(value => value !== 'PASS' && value !== 'ci').length, 0);
  writeFileSync(join(out, 'glyph-metrics.json'), JSON.stringify(glyphs, null, 2) + '\n');
  writeFileSync(join(out, 'gate-results.json'), JSON.stringify(results, null, 2) + '\n');
  const receipt = { source, harnessDigest: hash(fileURLToPath(import.meta.url)), pinDigest: hash(join(repo, 'scripts/ci/ui-gate-fonts.json')), helperDigest: hash(helper), browser: run(chrome, ['--version']).trim(), node: process.version, cold, warm, failure, glyphRowsPerPreparation: glyphs.control.length, identicalGlyphMetrics: true, gateChecksPerPreparation: Object.keys(results.control).length - 1, identicalGateResults: true, heldPeerExitAcknowledged: true, scope: 'Local original GATE=ci on one control product tree; apt-equivalent private configuration versus cache helper. Not a fresh GitHub-hosted apt run or full UI matrix.' };
  writeFileSync(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ coldMs: cold.elapsedMs, warmMs: warm.elapsedMs, failure, glyphRows: receipt.glyphRowsPerPreparation, gateChecks: receipt.gateChecksPerPreparation, identical: true }));
}
