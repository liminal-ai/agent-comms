import { privateFixture } from '../packages/windows-pipe/test/private-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, copyFile, symlink, stat } from 'node:fs/promises';
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
    if (process.platform !== 'win32') {
      // A regular file at the socket path is never deleted; the listener refuses to start instead.
      const { listenWeb } = await import('./serve-web.mjs');
      const notASocket = join(dir, 'precious.txt');
      await writeFile(notASocket, 'keep me');
      await assert.rejects(listenWeb(webServer({ environment: 'x', convexUrl: 'https://x.test' }, dir), { environment: 'x', socket: notASocket }, () => {}), /not a socket/);
      const { readFile: readBack } = await import('node:fs/promises');
      assert.equal(await readBack(notASocket, 'utf8'), 'keep me');
      // A live socket is never unlinked from under its owner; a stale one is.
      const live = join(dir, 'live.sock');
      const stop = (s) => new Promise((resolve) => { s.closeAllConnections(); s.close(resolve); });
      // A runtime 'error' after binding has no stale startup handler left to swallow it.
      const probe = await listenWeb(webServer({ environment: 'x', convexUrl: 'https://x.test' }, dir), { environment: 'x', socket: join(dir, 'probe.sock') }, () => {});
      try {
        assert.equal(probe.listenerCount('error'), 0, 'the startup error handler is detached once bound');
      } finally {
        await new Promise((resolve) => probe.close(resolve));
      }
      const before = process.umask();
      const first = await listenWeb(webServer({ environment: 'x', convexUrl: 'https://x.test' }, dir), { environment: 'x', socket: live }, () => {});
      try {
        assert.equal(process.umask(), before, 'umask restored');
        const { stat: statLive } = await import('node:fs/promises');
        assert.equal((await statLive(live)).mode & 0o777, 0o600);
        const contender = webServer({ environment: 'x', convexUrl: 'https://x.test' }, dir);
        await assert.rejects(listenWeb(contender, { environment: 'x', socket: live }, () => {}), /in use by another instance/);
        const stillServed = await new Promise((resolve, reject) => request({ socketPath: live, path: '/healthz', agent: false }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject).end());
        assert.equal(stillServed, 200, 'the first instance still answers on its socket');
      } finally {
        await stop(first);
      }
      // A stale socket file (its owner gone without cleaning up) is replaced.
      const { stat: statSock } = await import('node:fs/promises');
      const { createServer: rawServer } = await import('node:net');
      const stale = rawServer(); await new Promise((r) => stale.listen(live, r)); stale.unref();
      // Simulate an owner that died: close the handle without letting Node unlink the path.
      await new Promise((r) => stale.close(r));
      if (!(await statSock(live).then(() => true, () => false))) await writeFile(live, ''); // ensure something is there
      if ((await statSock(live)).isSocket()) {
        const second = await listenWeb(webServer({ environment: 'x', convexUrl: 'https://x.test' }, dir), { environment: 'x', socket: live }, () => {});
        try { assert.ok(second.listening, 'a stale socket is replaced'); } finally { await stop(second); }
      }
      // A lock left by a starter that died is taken over; one held by a live process is refused after the wait.
      const locked = join(dir, 'locked.sock');
      await writeFile(`${locked}.lock`, '999999999');
      const afterStale = await listenWeb(webServer({ environment: 'x', convexUrl: 'https://x.test' }, dir), { environment: 'x', socket: locked }, () => {});
      try { assert.ok(afterStale.listening, 'a stale lock does not block startup'); } finally { await stop(afterStale); }
      // A lock without a valid pid (starter killed mid-acquire) is reclaimed once it has sat untouched for the wait period.
      await writeFile(`${locked}.lock`, '');
      await new Promise((resolve) => setTimeout(resolve, 250));
      const afterEmpty = await listenWeb(webServer({ environment: 'x', convexUrl: 'https://x.test' }, dir), { environment: 'x', socket: locked, lockWaitMs: 200 }, () => {});
      try { assert.ok(afterEmpty.listening, 'an empty lock does not block startup forever'); } finally { await stop(afterEmpty); }
      assert.equal(await stat(`${locked}.lock`).then(() => true, () => false), false, 'the lock is released after startup');
      // A stale lock in a directory we can't modify is an error, not a spin.
      const roDir = join(dir, 'ro'); await mkdir(roDir);
      const roSock = join(roDir, 'web.sock');
      await writeFile(`${roSock}.lock`, '999999999');
      const { chmod: chmodDir } = await import('node:fs/promises');
      await chmodDir(roDir, 0o500);
      try {
        if (process.getuid?.() !== 0) await assert.rejects(listenWeb(webServer({ environment: 'x', convexUrl: 'https://x.test' }, dir), { environment: 'x', socket: roSock, lockWaitMs: 300 }, () => {}), /EACCES|EPERM/, 'a reclaim that cannot happen fails loudly');
      } finally {
        await chmodDir(roDir, 0o700);
      }
      // A reclaim guard left by a dead reclaimer doesn't block reclaiming a stale lock.
      await writeFile(`${locked}.lock`, '999999999');
      await writeFile(`${locked}.lock.reclaim`, '999999998');
      await new Promise((resolve) => setTimeout(resolve, 250));
      const afterGuard = await listenWeb(webServer({ environment: 'x', convexUrl: 'https://x.test' }, dir), { environment: 'x', socket: locked, lockWaitMs: 200 }, () => {});
      try { assert.ok(afterGuard.listening, 'a stale guard is reclaimed too'); } finally { await stop(afterGuard); }
      // A guard held by a live reclaimer makes us wait, then refuse.
      await writeFile(`${locked}.lock`, '999999999');
      await writeFile(`${locked}.lock.reclaim`, String(process.pid));
      await assert.rejects(listenWeb(webServer({ environment: 'x', convexUrl: 'https://x.test' }, dir), { environment: 'x', socket: locked, lockWaitMs: 200 }, () => {}), /another instance is starting/);
      await rm(`${locked}.lock.reclaim`); await rm(`${locked}.lock`);
      // A dangling symlink (or any non-regular entry) at the lock path is an error, not a spin.
      await rm(`${locked}.lock`, { force: true });
      await symlink(join(dir, 'nowhere'), `${locked}.lock`);
      await assert.rejects(listenWeb(webServer({ environment: 'x', convexUrl: 'https://x.test' }, dir), { environment: 'x', socket: locked, lockWaitMs: 200 }, () => {}), /not a regular file/);
      await rm(`${locked}.lock`);
      await writeFile(`${locked}.lock`, String(process.pid));
      await assert.rejects(listenWeb(webServer({ environment: 'x', convexUrl: 'https://x.test' }, dir), { environment: 'x', socket: locked, lockWaitMs: 200 }, () => {}), /another instance is starting/);
      await rm(`${locked}.lock`);
      // Two starters racing for the same stale socket: exactly one binds, and it keeps serving.
      const raced = join(dir, 'raced.sock');
      const abandoned = rawServer(); await new Promise((r) => abandoned.listen(raced, r)); abandoned.unref();
      await new Promise((r) => abandoned.close(r));
      if (!(await statSock(raced).then(() => true, () => false))) await writeFile(raced, '');
      if ((await statSock(raced)).isSocket()) {
        const outcomes = await Promise.allSettled([1, 2].map(() => listenWeb(webServer({ environment: 'x', convexUrl: 'https://x.test' }, dir), { environment: 'x', socket: raced }, () => {})));
        const winners = outcomes.filter((o) => o.status === 'fulfilled').map((o) => o.value);
        try {
          assert.equal(winners.length, 1, `exactly one starter wins (${outcomes.map((o) => o.status).join(', ')})`);
          const health = await new Promise((resolve, reject) => request({ socketPath: raced, path: '/healthz' }, (res) => resolve(res.statusCode)).on('error', reject).end());
          assert.equal(health, 200, 'the winner serves at the path');
        } finally {
          await Promise.all(winners.map((w) => stop(w)));
        }
      }
      // Deployed shape: a mode-600 unix socket for the serve hop.
      const sock = join(dir, 'web.sock');
      const sockConfig = join(dir, 'config-sock.json');
      await writeFile(sockConfig, JSON.stringify({ environment: 'staging', convexUrl: 'https://staging.example.test', socket: sock, adminTokenFile: tokenFile, allowedClients: ['100.100.0.1'], publicHosts: ['comms.example.test:8464'] }));
      const sockChild = spawn(process.execPath, [entry, sockConfig], { stdio: ['ignore', 'pipe', 'pipe'] });
      try {
        const line = await once(sockChild.stdout, 'data').then(([data]) => data.toString());
        assert.match(line, /unix:/);
        const { stat } = await import('node:fs/promises');
        assert.equal((await stat(sock)).mode & 0o777, 0o600);
        assert.equal(process.umask(), process.umask(), 'the parent umask is untouched');
        const viaSock = await new Promise((resolve, reject) => {
          request({ socketPath: sock, path: '/runtime-config.json', headers: { host: 'comms.example.test:8464', 'x-forwarded-for': '100.100.0.1' } }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject).end();
        });
        assert.equal(viaSock.status, 200);
        assert.deepEqual(JSON.parse(viaSock.body), { environment: 'staging', mode: 'proxy' });
      } finally {
        const stopped = once(sockChild, 'exit'); sockChild.kill(); await stopped;
      }
    }
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
    assert.throws(() => webListener({ environment: 'prod', convexUrl: 'https://prod.example.test', adminTokenFile: tokenFile, devAllowLoopback: true }, dir, () => {}), /needs allowedClients and publicHosts/, 'the dev flag never lifts the requirement');
    const proxy = webListener({ environment: 'prod', convexUrl: 'https://prod.example.test', adminTokenFile: tokenFile, allowedClients: ['100.100.0.1'], publicHosts: ['comms.example.test:8461'] }, dir, () => {}); servers.push(proxy);
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const pport = proxy.address().port;
    const config = (await getAs(pport, { host: 'comms.example.test:8461', 'x-forwarded-for': '100.100.0.1' })).body;
    assert.equal((await getAs(pport, { host: 'attacker.example:8461', 'x-forwarded-for': '100.100.0.1' })).status, 403, 'foreign Host');
    assert.equal((await getAs(pport, { host: 'comms.example.test:8461', 'x-forwarded-for': '100.100.0.9' })).status, 403, 'unlisted client');
    assert.equal((await getAs(pport, { host: 'comms.example.test:8461' })).status, 403, 'no forwarded client');
    assert.deepEqual(JSON.parse(config), { environment: 'prod', mode: 'proxy' });
    // close() finishes even with a watch stream held open by a client that never hangs up.
    const held = webListener({ environment: 'prod', convexUrl: 'https://prod.example.test', adminTokenFile: tokenFile, allowedClients: ['127.0.0.1'], publicHosts: ['comms.example.test:8461'] }, dir, () => {});
    await new Promise(resolve => held.listen(0, '127.0.0.1', resolve));
    const hport = held.address().port;
    const stream = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: hport, method: 'POST', path: '/api/watch', headers: { host: 'comms.example.test:8461', 'x-forwarded-for': '127.0.0.1', 'content-type': 'application/json' } }, resolve);
      req.on('error', reject);
      req.end(JSON.stringify({ queries: [{ id: 'q', name: 'directory:list', args: {} }] }));
    });
    assert.equal(stream.statusCode, 200, 'the watch stream is open');
    const closed = await Promise.race([new Promise(resolve => held.close(() => resolve('closed'))), new Promise(resolve => setTimeout(() => resolve('hung'), 5000))]);
    assert.equal(closed, 'closed', 'close() ends the held stream instead of waiting on it');
    stream.destroy();
    assert.doesNotMatch(config, /released-admin-token/);
  } finally {
    await Promise.all(servers.map(s => new Promise(resolve => { s.closeAllConnections(); s.close(resolve); })));
    await rm(dir, { recursive: true });
  }
});
