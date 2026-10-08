// The released web listener. With `adminTokenFile` in its config it runs in proxy mode: the
// page gets no token and calls POST /api/call and /api/watch here, and this process adds the
// admin token (read from the file at each call) before forwarding to Convex. Without one it
// only serves the built page and a token-free runtime-config.json (the page then asks for a token).
// `allowedClients` (proxy mode) limits who is served to the tailnet addresses tailscale serve reports
// in X-Forwarded-For; `devAllowLoopback: true` lets header-less loopback requests through in development.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { chmod, link, lstat, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localWebServer } from '../packages/service/src/web.ts';
import { convexWebBackend } from '../packages/service/src/convex-backend.ts';

/**
 * Starts the listener where the config says: a unix socket (`socket`, created mode 600, so only this
 * user and root, which tailscaled is, can open it: the proxy hop can't be forged by another local
 * account), or 127.0.0.1:`port`. A stale socket at the path is replaced; anything else there is an error.
 */
export async function listenWeb(server, config, log = (line) => console.log(line)) {
  if (config.socket) {
    // Starters take turns under a lock, so the probe, the removal of a stale socket and the bind
    // happen with no other starter in between, and a live socket keeps its path throughout.
    await withStartLock(config.socket, config.lockWaitMs ?? 5000, async () => {
      // Looked at under the lock, so it can't have changed under us by the time we act on it.
      const existing = await lstat(config.socket).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
      if (existing && !existing.isSocket()) throw new Error(`web config: socket path ${config.socket} exists and is not a socket; refusing to replace it`);
      if (existing) {
        // Only a stale socket (nobody listening) is replaced; a live one belongs to a running instance.
        if (await socketAnswers(config.socket)) throw new Error(`web config: socket ${config.socket} is in use by another instance; refusing to take it over`);
        await rm(config.socket, { force: true });
      }
      // Created mode 600 from the first instant (umask 177), so nobody can connect before the chmod below.
      const umask = process.umask(0o177);
      try {
        await bind(server, config.socket);
      } finally {
        process.umask(umask);
      }
      await chmod(config.socket, 0o600);
    });
    log(`Comms ${config.environment} web: unix:${config.socket}${config.adminTokenFile ? ' (proxy mode)' : ''}`);
  } else {
    await bind(server, config.port, '127.0.0.1');
    log(`Comms ${config.environment} web: 127.0.0.1:${server.address().port}${config.adminTokenFile ? ' (proxy mode)' : ''}`);
  }
  return server;
}

/**
 * Runs fn holding `<socket>.lock`, created exclusively with this pid inside. A lock whose pid is gone
 * is stale and is taken over; one held by a live process is waited on for up to waitMs, then refused.
 */
async function withStartLock(socket, waitMs, fn) {
  const lock = `${socket}.lock`;
  const deadline = Date.now() + waitMs;
  // The pid is written to a private file first and published by link(): the lock either exists
  // with the pid inside or not at all, so a starter killed mid-acquire leaves nothing half-written.
  const mine = `${lock}.${process.pid}.${randomBytes(4).toString('hex')}.pid`;
  await writeFile(mine, String(process.pid), { mode: 0o600 });
  try {
    for (;;) {
      const acquired = await link(mine, lock).then(() => true, (error) => { if (error.code === 'EEXIST') return false; throw error; });
      if (acquired) break;
      const seen = await stat(lock).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
      if (seen === null) continue; // gone between our link() and now: try the link again
      const holder = Number((await readFile(lock, 'utf8').catch(() => '')).trim());
      // Stale: its pid is gone, or it never got a valid pid and nobody has touched it for the wait period.
      if ((holder && !processAlive(holder)) || (!holder && Date.now() - seen.mtimeMs >= waitMs)) {
        // Reclaim only the entry we inspected: if another starter replaced it meanwhile, the inode
        // differs and we leave the new holder alone. ENOENT means someone else reclaimed it first.
        const taken = `${lock}.${process.pid}.${randomBytes(4).toString('hex')}.stale`;
        const now = await stat(lock).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
        if (now !== null && now.ino === seen.ino && now.dev === seen.dev) {
          const reclaimed = await rename(lock, taken).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; });
          if (reclaimed) {
            const got = await stat(taken);
            if (got.ino === seen.ino) { await rm(taken, { force: true }); continue; }
            // We moved a lock that had just been replaced; put it back for its owner.
            await rename(taken, lock).catch(() => {});
          }
        }
      }
      if (Date.now() >= deadline) throw new Error(`web config: another instance is starting on ${socket} (lock ${lock} held by pid ${holder || 'unknown'})`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    await rm(mine, { force: true });
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { force: true });
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function socketAnswers(path) {
  return new Promise((resolve) => {
    const probe = connect(path);
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', () => resolve(false));
  });
}

/** The listener for a web config: proxy mode when it names an admin token file, static otherwise. */
export function webListener(config, root, log = (line) => console.log(line)) {
  if (!config.adminTokenFile) return webServer(config, root);
  if (config.allowedClients !== undefined && (!Array.isArray(config.allowedClients) || !config.allowedClients.every((a) => typeof a === 'string'))) throw new Error('web config: allowedClients must be a list of IP addresses');
  if (config.devAllowLoopback !== undefined && typeof config.devAllowLoopback !== 'boolean') throw new Error('web config: devAllowLoopback must be true or false');
  if (config.publicHosts !== undefined && (!Array.isArray(config.publicHosts) || !config.publicHosts.every((h) => typeof h === 'string' && h))) throw new Error('web config: publicHosts must be a list of host[:port] values');
  // A proxy that admits any client would hand the page's admin power to the whole network. Deployments must say who.
  // devAllowLoopback only adds a loopback exception for development; it never lifts these.
  if (!config.allowedClients?.length || !config.publicHosts?.length) {
    throw new Error('web config: proxy mode (adminTokenFile) needs allowedClients and publicHosts');
  }
  if (config.socket !== undefined && (typeof config.socket !== 'string' || !config.socket.startsWith('/'))) throw new Error('web config: socket must be an absolute path');
  const backend = convexWebBackend({ convexUrl: config.convexUrl, adminTokenFile: config.adminTokenFile, log });
  const server = localWebServer({
    backend, environment: config.environment, mode: 'proxy', root, log,
    ...(config.allowedClients ? { allowedClients: config.allowedClients } : {}),
    ...(config.devAllowLoopback ? { devAllowLoopback: true } : {}),
    ...(config.publicHosts ? { publicHosts: config.publicHosts } : {}),
  });
  const close = server.close.bind(server);
  // Open /api/watch streams would keep close() from ever finishing; end them once the listener is shut.
  server.close = (cb) => { const result = close(cb); server.closeAllConnections(); void backend.close(); return result; };
  return server;
}

/** Resolves once the server listens, rejects if binding fails; the startup error handler is gone either way, so a later runtime error isn't swallowed by it. */
function bind(server, ...args) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(...args, () => { server.off('error', onError); resolve(); });
  });
}

export function webServer(config, root) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      let body;
      if (pathname === '/runtime-config.json') {
        // Never the admin token: a config with adminTokenFile is served by webListener's proxy mode instead.
        body = JSON.stringify({ environment: config.environment, convexUrl: config.convexUrl });
        res.setHeader('Content-Type', 'application/json');
      } else if (pathname === '/healthz') {
        body = JSON.stringify({ environment: config.environment, status: 'ok' });
        res.setHeader('Content-Type', 'application/json');
      } else {
        const path = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
        if (!path.startsWith(resolve(root) + sep)) { res.writeHead(403); res.end(); return; }
        body = await readFile(path);
        res.setHeader('Content-Type', types[extname(path)] ?? 'application/octet-stream');
      }
      res.writeHead(200); res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end('Request failed');
    }
  });
}

// Resolve both sides with the same API: Windows module URLs can preserve a
// different drive/path spelling than the filesystem's canonical realpath.
// Bundled into service.mjs, this module's URL is the service's: only run as serve-web.mjs itself.
if (process.argv[1] && basename(fileURLToPath(import.meta.url)) === 'serve-web.mjs' && await realpath(fileURLToPath(import.meta.url)) === await realpath(process.argv[1])) {
  const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
  if (!config.environment || !config.convexUrl || (!config.socket && !Number.isInteger(config.port))) throw new Error('web config requires environment, convexUrl and port (or socket)');
  if (!['http:', 'https:'].includes(new URL(config.convexUrl).protocol)) throw new Error('Invalid public Convex URL');
  const root = fileURLToPath(new URL('./web', import.meta.url));
  await listenWeb(webListener(config, root), config, (line) => console.log(line));
}
