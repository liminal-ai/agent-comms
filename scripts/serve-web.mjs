import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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
        const adminToken = config.adminTokenFile ? (await readFile(config.adminTokenFile, 'utf8')).trim() : undefined;
        body = JSON.stringify({ environment: config.environment, convexUrl: config.convexUrl, ...(adminToken ? { adminToken } : {}) });
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
if (process.argv[1] && await realpath(fileURLToPath(import.meta.url)) === await realpath(process.argv[1])) {
  const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
  if (!config.environment || !config.convexUrl || !Number.isInteger(config.port)) throw new Error('web config requires environment, convexUrl and port');
  if (!['http:', 'https:'].includes(new URL(config.convexUrl).protocol)) throw new Error('Invalid public Convex URL');
  const root = fileURLToPath(new URL('./web', import.meta.url));
  webServer(config, root).listen(config.port, '127.0.0.1', () => console.log(`Comms ${config.environment} web: 127.0.0.1:${config.port}`));
}
