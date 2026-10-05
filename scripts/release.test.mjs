import { privateFixture } from '../packages/windows-pipe/test/private-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, copyFile, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webServer } from './serve-web.mjs';
import { verifyT3Binding } from '../packages/connector/src/config.ts';

for (const lowerDrive of (process.platform === 'win32' ? [false, true] : [false])) {
test('web service starts through the deployed current directory link' + (lowerDrive ? ' with lower-case drive spelling' : ''), { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comms-launch-'));
  let child;
  try {
    const release = join(dir, 'release');
    await mkdir(join(release, 'web'), { recursive: true });
    await copyFile(new URL('./serve-web.mjs', import.meta.url), join(release, 'serve-web.mjs'));
    await writeFile(join(release, 'web/index.html'), 'released web');
    // Windows directory junctions exercise the same realpath launch without symlink privileges.
    await symlink(release, join(dir, 'current'), process.platform === 'win32' ? 'junction' : 'dir');
    const config = join(dir, 'config.json');
    await writeFile(config, JSON.stringify({ environment: 'staging', convexUrl: 'https://staging.example.test', port: 0 }));
    const entry = join(dir, 'current/serve-web.mjs');
    child = spawn(process.execPath, [lowerDrive ? entry[0].toLowerCase() + entry.slice(1) : entry, config], { stdio: ['ignore', 'pipe', 'pipe'] });
    const result = await Promise.race([
      once(child.stdout, 'data').then(([data]) => data.toString()),
      once(child, 'exit').then(([code]) => { throw new Error(`web exited before listening: ${code}`); }),
    ]);
    assert.match(result, /Comms staging web: 127.0.0.1:/);
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
  } finally {
    await Promise.all(servers.map(s => new Promise(resolve => { s.closeAllConnections(); s.close(resolve); })));
    await rm(dir, { recursive: true });
  }
});
