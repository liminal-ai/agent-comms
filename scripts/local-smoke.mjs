// Local mode from a built release, outside the checkout (no node_modules):
// copy dist/agent-comms-<version>, start service.mjs on a private data
// directory, socket and port, register two agents, send and read through the
// bundled CLI, restart, and check the message and pending delivery survived.
//
//   node scripts/local-smoke.mjs <version>

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { windowsEndpoint } from '../packages/windows-pipe/src/index.mjs';

const exec = promisify(execFile);
const version = process.argv[2];
if (!version) throw new Error('usage: local-smoke.mjs <version>');
const root = await mkdtemp(join(tmpdir(), 'comms-local-smoke-'));
const release = join(root, 'release');
await cp(resolve('dist', `agent-comms-${version}`), release, { recursive: true });
const port = await new Promise((done) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => done(p)); }); });
// Windows: the current user's pipe, as the service requires.
const socket = process.platform === 'win32' ? windowsEndpoint(`local-smoke-${process.pid}`) : join(root, 'run', 'connector.sock');
const config = join(root, 'service.json');
await writeFile(config, JSON.stringify({ mode: 'local', environment: 'smoke', dataDir: join(root, 'data'), owner: 'lee', machine: 'smoke', socket, web: { port } }));
// Processes run from outside the fixture: on Windows a pipe bridge left by a killed service
// still holds its working directory for a moment, which would keep the fixture from being removed.
const outside = tmpdir();
const node = (script, args, env = {}) => exec(process.execPath, [join(release, script), ...args], { cwd: outside, env: { ...process.env, ...env }, windowsHide: true, timeout: 30_000 });
const comms = (...args) => node('comms.mjs', args, { AGENT_COMMS_SOCKET: socket }).then((r) => r.stdout);

let child;
async function start() {
  child = spawn(process.execPath, [join(release, 'service.mjs'), '--config', config], { cwd: outside, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let log = '';
  child.stderr.on('data', (d) => { log += d; });
  const deadline = Date.now() + 20_000;
  while (!/local comms service running/.test(log)) {
    if (child.exitCode !== null) throw new Error(`service exited: ${log}`);
    if (Date.now() > deadline) throw new Error(`service didn't start: ${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
async function stop() {
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}

try {
  await start();
  for (const name of ['alpha', 'beta']) await node('service.mjs', ['register', '--config', config, name, '--harness', 'claude-code', '--locator', name]);
  assert.match(await comms('status'), /@alpha.*\n.*@beta/);
  const sent = await comms('send', '--as', 'alpha', '@beta', 'local smoke', '--continue');
  const conversation = /in ([0-9a-z]{32})\)/.exec(sent)?.[1];
  assert.ok(conversation, sent);
  const page = await fetch(`http://127.0.0.1:${port}/runtime-config.json`).then((r) => r.json());
  assert.deepEqual(page, { environment: 'smoke', mode: 'local' });
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  await stop();
  await start();
  assert.match(await comms('read', '--as', 'alpha', conversation), /local smoke/);
  assert.match(await comms('status'), /@beta/);
  console.log('Local mode from the release: start, register, send, read, restart: pass');
} finally {
  if (child && child.exitCode === null) await stop();
  // Windows releases a killed service's files and pipe bridge shortly after exit: retry briefly.
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
