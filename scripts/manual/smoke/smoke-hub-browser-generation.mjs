/** node <this> <compiled-dist> <private-scratch-parent> [<old-generator-module>]; no services or host config edits. */
import assert from 'node:assert/strict';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer, get } from 'node:https';

const [dist, parent, oldModule] = process.argv.slice(2);
assert(dist && parent, 'compiled dist and private scratch parent are required');
const { createBrowserCertificate, recoverBrowserCertificate } = await import(pathToFileURL(resolve(dist, 'hub/init/browser-certificate.js')));
const { checkBrowserTls } = await import(pathToFileURL(resolve(dist, 'hub/init/browser-tls.js')));
const root = mkdtempSync(join(resolve(parent), 'browser-generation-'));
let count = 0;
try {
  for (const origin of ['https://127.0.0.1', 'https://[2001:db8::10]', 'https://hub.example.test']) {
    const material = await createBrowserCertificate(root, origin);
    const cert = readFileSync(material.certFile), key = readFileSync(material.keyFile), leaf = new X509Certificate(cert);
    assert.equal(checkBrowserTls(cert.toString(), key.toString(), origin).ok, true);
    assert.equal(leaf.ca, false); assert(leaf.checkPrivateKey(createPrivateKey(key)));
    assert.equal(Date.parse(leaf.validTo) - Date.parse(leaf.validFrom), 30 * 86400000);
    assert.deepEqual(leaf.keyUsage, ['1.3.6.1.5.5.7.3.1']);
    assert.equal(statSync(dirname(material.certFile)).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(dirname(material.certFile)).sort(), ['cert.pem', 'key.pem', 'material.json']);
    for (const file of ['cert.pem', 'key.pem', 'material.json']) assert.equal(statSync(join(dirname(material.certFile), file)).mode & 0o777, 0o600);
    if (origin === 'https://127.0.0.1') {
      const server = createServer({ cert, key }, (_req, res) => res.end('verified'));
      try {
        await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
        const address = server.address(); assert(address && typeof address === 'object');
        const body = await new Promise((resolveBody, reject) => {
          const req = get(`https://127.0.0.1:${address.port}`, { ca: cert, timeout: 2000 }, res => {
            let body = ''; res.on('data', x => body += x); res.on('end', () => resolveBody(body));
          }); req.on('error', reject); req.on('timeout', () => req.destroy(new Error('HTTPS probe deadline')));
        }); assert.equal(body, 'verified'); count++;
      } finally { await new Promise((resolveClose, reject) => server.close(err => err ? reject(err) : resolveClose())); }
    }
    recoverBrowserCertificate(root, origin, { certFile: material.certFile, keyFile: material.keyFile, generated: true }).cleanup();
    material.cleanup(); assert.deepEqual(readdirSync(root), []); count++;
  }
  await assert.rejects(createBrowserCertificate(root, 'https://a.test,b.test'), /invalid_browser_origin/);
  assert.deepEqual(readdirSync(root), []); count++;
  if (oldModule) {
    const old = await import(pathToFileURL(resolve(oldModule)));
    await assert.rejects(old.createBrowserCertificate(root, 'https://127.0.0.1'), /browser_certificate_generation_failed/);
    assert.deepEqual(readdirSync(root), []); count++;
  }
  console.log(JSON.stringify({ passed: count, generatedSans: 3, verifiedHttps: true, stagingClean: true, oldControlRefused: !!oldModule }));
} finally { rmSync(root, { recursive: true, force: true }); }
