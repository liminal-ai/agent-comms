import { readFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const [configFile, binary, stateDir] = process.argv.slice(2);
if (!stateDir) throw new Error('usage: run-convex.mjs <config.json> <backend-binary> <data-dir>');
const c = JSON.parse(readFileSync(configFile, 'utf8'));
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const child = spawn(binary, [
  '--interface', '127.0.0.1', '--port', String(c.ports.cloud), '--site-proxy-port', String(c.ports.site),
  '--convex-origin', c.publicUrl ?? `http://127.0.0.1:${c.ports.cloud}`,
  '--convex-site', c.siteUrl ?? `http://127.0.0.1:${c.ports.site}`,
  '--instance-name', c.deploymentName, '--instance-secret', c.instanceSecret,
  '--local-storage', resolve(stateDir, 'convex_local_storage'), '--disable-beacon', resolve(stateDir, 'convex_local_backend.sqlite3'),
], { stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('error', () => { console.error('Convex backend could not start'); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGTERM' ? 0 : 1); });
