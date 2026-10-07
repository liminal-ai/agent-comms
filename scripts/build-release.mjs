import { build } from 'esbuild';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(version)) throw new Error('Pass a release version');
const dest = resolve('dist', `agent-comms-${version}`);
await mkdir('dist', { recursive: true });
await mkdir(dest, { recursive: false });
await build({
  entryPoints: {
    connector: 'packages/connector/src/main.ts', comms: 'packages/comms-cli/src/main.ts',
    upgrade: 'scripts/upgrade.ts', setup: 'scripts/dev-setup.ts', service: 'packages/service/src/main.ts', oaidot: 'packages/oaidot/src/main.ts', grokbot: 'packages/grokbot/src/main.ts',
  }, outdir: dest, outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', target: 'node24',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});
// Runtime companion files resolve beside the bundled entrypoint via import.meta.url.
for (const name of ['bridge.ps1','PrivatePipe.cs','Bridge.cs','validate-secret.ps1','SecretFile.cs','protect-secret.ps1','private-dir.ps1']) {
  await cp(`packages/windows-pipe/src/${name}`, `${dest}/${name}`);
}
// The standalone Claude Code plugin (marketplace + plugin manifests and its hooks), loadable from the
// release with --plugin-dir or `claude plugin marketplace add`; no source checkout needed.
await cp('packages/claude-code-mod/.claude-plugin', `${dest}/claude-plugin/.claude-plugin`, { recursive: true });
await cp('packages/claude-code-mod/hooks', `${dest}/claude-plugin/hooks`, { recursive: true });
execFileSync('pnpm', ['--filter', '@agent-comms/web', 'build'], { stdio: 'inherit', shell: process.platform === 'win32' });
await cp('apps/web/dist', `${dest}/web`, { recursive: true });
for (const name of ['serve-web.mjs', 'run-convex.mjs']) await cp(`scripts/${name}`, `${dest}/${name}`);
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
await writeFile(`${dest}/release.json`, JSON.stringify({ version, commit, node: '24.18.0', convexBackend: 'precompiled-2026-09-28-5c7cb5b' }, null, 2)+'\n');
console.log(dest);
