import { privateFixture } from '../packages/windows-pipe/test/private-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, copyFile, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { webListener, webServer } from './serve-web.mjs';
import { verifyT3Binding } from '../packages/connector/src/config.ts';

// fetch() won't send a chosen Host header; a raw request can, as a request through tailscale serve would arrive.
const getAs = (port, headers) => new Promise((resolve, reject) => {
  request({ host: '127.0.0.1', port, path: '/runtime-config.json', headers }, (res) => {
    let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject).end();
});

for (const lowerDrive of (process.platform === 'win32' ? [false, true] : [false])) {
test('web service starts through the deployed current directory link' + (lowerDrive ? ' with lower-case drive spelling' : ''), { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comms-launch-'));
  let child;
  try {
    const release = join(dir, 'release');
    await mkdir(join(release, 'web'), { recursive: true });
    // Released as a bundle (it imports the service's web API and convex); build it the same way.
    await build({ entryPoints: { 'serve-web': fileURLToPath(new URL('./serve-web.mjs', import.meta.url)) }, outdir: release, outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent', banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } });
    await writeFile(join(release, 'web/index.html'), 'released web');
    // Windows directory junctions exercise the same realpath launch without symlink privileges.
    await symlink(release, join(dir, 'current'), process.platform === 'win32' ? 'junction' : 'dir');
    // Proxy mode, as deployed: the bundle must hold the token and keep it out of the page's config.
    const tokenFile = join(dir, 'admin-token');
    await writeFile(tokenFile, 'bundled-admin-token');
    const config = join(dir, 'config.json');
    await writeFile(config, JSON.stringify({ environment: 'staging', convexUrl: 'https://staging.example.test', port: 0, adminTokenFile: tokenFile, allowedClients: ['100.100.0.1'], publicHosts: ['comms.example.test:8464'] }));
    const entry = join(dir, 'current/serve-web.mjs');
    child = spawn(process.execPath, [lowerDrive ? entry[0].toLowerCase() + entry.slice(1) : entry, config], { stdio: ['ignore', 'pipe', 'pipe'] });
    const result = await Promise.race([
      once(child.stdout, 'data').then(([data]) => data.toString()),
      once(child, 'exit').then(([code]) => { throw new Error(`web exited before listening: ${code}`); }),
    ]);
    assert.match(result, /Comms staging web: 127.0.0.1:(\d+) \(proxy mode\)/);
    const port = /127.0.0.1:(\d+)/.exec(result)[1];
    const served = (await getAs(port, { host: 'comms.example.test:8464', 'x-forwarded-for': '100.100.0.1' })).body;
    assert.deepEqual(JSON.parse(served), { environment: 'staging', mode: 'proxy' });
    assert.doesNotMatch(served, /bundled-admin-token/);
  } finally {
    if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
    await rm(dir, { recursive: true });
  }
});
}

test('binding refuses a different T3 before sending any credential', async () => {
  const requests = [];
  await assert.rejects(verifyT3Binding({ baseUrl: 'http://localhost:13976', authFile: '/must-not-read', environmentId: 'staging' }, async (url) => {
    requests.push(url); return Response.json({ environmentId: 'production' });
  }), /identity mismatch/);
  assert.deepEqual(requests, ['http://localhost:13976/.well-known/t3/environment']);
});

test('binding requires both expected identity and an authenticated session', async () => {
  const fixture = await privateFixture('fixture-token');
  try {
    const authFile = fixture.path;
    const config = { baseUrl: 'http://localhost:13976', authFile, environmentId: 'staging' };
    let accept = false;
    const request = async (url, options) => {
      if (url.endsWith('/environment')) return Response.json({ environmentId: 'staging' });
      assert.equal(options.headers.authorization, 'Bearer fixture-token');
      return Response.json({ authenticated: accept });
    };
    await assert.rejects(verifyT3Binding(config, request), /credential rejected/);
    accept = true; await verifyT3Binding(config, request);
  } finally { await fixture.cleanup(); }
});

test('one web build serves each environment config at runtime, without leaking other files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comms-web-'));
  await writeFile(join(dir, 'index.html'), '<div>comms release</div>');
  const servers = [];
  try {
    for (const environment of ['prod', 'staging']) {
      const config = { environment, convexUrl: `https://${environment}.example.test` };
      const server = webServer(config, dir); servers.push(server);
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${server.address().port}`;
      const response = await fetch(url + '/runtime-config.json');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), config);
      assert.equal(await (await fetch(url)).text(), '<div>comms release</div>');
      assert.equal((await fetch(url + '/%2e%2e%2fsecret')).status, 403);
      assert.equal((await fetch(url + '/missing.js')).status, 404);
      assert.equal((await fetch(url, { method: 'POST' })).status, 405);
    }
    // With an admin token file the listener runs in proxy mode and the token never reaches the page.
    const tokenFile = join(dir, 'admin-token');
    await writeFile(tokenFile, 'released-admin-token');
    assert.throws(() => webListener({ environment: 'prod', convexUrl: 'https://prod.example.test', adminTokenFile: tokenFile }, dir, () => {}), /needs allowedClients and publicHosts/);
    const proxy = webListener({ environment: 'prod', convexUrl: 'https://prod.example.test', adminTokenFile: tokenFile, allowedClients: ['100.100.0.1'], publicHosts: ['comms.example.test:8461'] }, dir, () => {}); servers.push(proxy);
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const pport = proxy.address().port;
    const config = (await getAs(pport, { host: 'comms.example.test:8461', 'x-forwarded-for': '100.100.0.1' })).body;
    assert.equal((await getAs(pport, { host: 'attacker.example:8461', 'x-forwarded-for': '100.100.0.1' })).status, 403, 'foreign Host');
    assert.equal((await getAs(pport, { host: 'comms.example.test:8461', 'x-forwarded-for': '100.100.0.9' })).status, 403, 'unlisted client');
    assert.equal((await getAs(pport, { host: 'comms.example.test:8461' })).status, 403, 'no forwarded client');
    assert.deepEqual(JSON.parse(config), { environment: 'prod', mode: 'proxy' });
    assert.doesNotMatch(config, /released-admin-token/);
  } finally {
    await Promise.all(servers.map(s => new Promise(resolve => { s.closeAllConnections(); s.close(resolve); })));
    await rm(dir, { recursive: true });
  }
});
