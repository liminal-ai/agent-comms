import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webServer } from './serve-web.mjs';
import { verifyT3Binding } from '../packages/connector/src/config.ts';

test('binding refuses a different T3 before sending any credential', async () => {
  const requests = [];
  await assert.rejects(verifyT3Binding({ baseUrl: 'http://localhost:13976', authFile: '/must-not-read', environmentId: 'staging' }, async (url) => {
    requests.push(url); return Response.json({ environmentId: 'production' });
  }), /identity mismatch/);
  assert.deepEqual(requests, ['http://localhost:13976/.well-known/t3/environment']);
});

test('binding requires both expected identity and an authenticated session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comms-binding-'));
  try {
    const authFile = join(dir, 'token'); await writeFile(authFile, 'fixture-token');
    const config = { baseUrl: 'http://localhost:13976', authFile, environmentId: 'staging' };
    let accept = false;
    const request = async (url, options) => {
      if (url.endsWith('/environment')) return Response.json({ environmentId: 'staging' });
      assert.equal(options.headers.authorization, 'Bearer fixture-token');
      return Response.json({ authenticated: accept });
    };
    await assert.rejects(verifyT3Binding(config, request), /credential rejected/);
    accept = true; await verifyT3Binding(config, request);
  } finally { await rm(dir, { recursive: true }); }
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
