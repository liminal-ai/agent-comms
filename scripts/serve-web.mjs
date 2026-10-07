// The released web listener. With `adminTokenFile` in its config it runs in proxy mode: the
// page gets no token and calls POST /api/call and /api/watch here, and this process adds the
// admin token (read from the file at each call) before forwarding to Convex. Without one it
// only serves the built page and a token-free runtime-config.json (the page then asks for a token).
// `allowedClients` (proxy mode) limits who is served to the tailnet addresses tailscale serve reports
// in X-Forwarded-For; `devAllowLoopback: true` lets header-less loopback requests through in development.
import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { basename, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localWebServer } from '../packages/service/src/web.ts';
import { convexWebBackend } from '../packages/service/src/convex-backend.ts';

/** The listener for a web config: proxy mode when it names an admin token file, static otherwise. */
export function webListener(config, root, log = (line) => console.log(line)) {
  if (!config.adminTokenFile) return webServer(config, root);
  if (config.allowedClients !== undefined && (!Array.isArray(config.allowedClients) || !config.allowedClients.every((a) => typeof a === 'string'))) throw new Error('web config: allowedClients must be a list of IP addresses');
  if (config.devAllowLoopback !== undefined && typeof config.devAllowLoopback !== 'boolean') throw new Error('web config: devAllowLoopback must be true or false');
  if (config.publicHosts !== undefined && (!Array.isArray(config.publicHosts) || !config.publicHosts.every((h) => typeof h === 'string' && h))) throw new Error('web config: publicHosts must be a list of host[:port] values');
  // A proxy that admits any client would hand the page's admin power to the whole network. Deployments must say who.
  if (!config.devAllowLoopback && (!config.allowedClients?.length || !config.publicHosts?.length)) {
    throw new Error('web config: proxy mode (adminTokenFile) needs allowedClients and publicHosts; devAllowLoopback: true is for development only');
  }
  const backend = convexWebBackend({ convexUrl: config.convexUrl, adminTokenFile: config.adminTokenFile, log });
  const server = localWebServer({
    backend, environment: config.environment, mode: 'proxy', root, log,
    ...(config.allowedClients ? { allowedClients: config.allowedClients } : {}),
    ...(config.devAllowLoopback ? { devAllowLoopback: true } : {}),
    ...(config.publicHosts ? { publicHosts: config.publicHosts } : {}),
  });
  const close = server.close.bind(server);
  server.close = (cb) => { void backend.close(); return close(cb); };
  return server;
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
  if (!config.environment || !config.convexUrl || !Number.isInteger(config.port)) throw new Error('web config requires environment, convexUrl and port');
  if (!['http:', 'https:'].includes(new URL(config.convexUrl).protocol)) throw new Error('Invalid public Convex URL');
  const root = fileURLToPath(new URL('./web', import.meta.url));
  const server = webListener(config, root);
  server.listen(config.port, '127.0.0.1', () => console.log(`Comms ${config.environment} web: 127.0.0.1:${server.address().port}${config.adminTokenFile ? ' (proxy mode)' : ''}`));
}
