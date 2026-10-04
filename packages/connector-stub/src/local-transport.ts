import { chmod, unlink } from 'node:fs/promises';
import type { Server } from 'node:http';
import { prepareSocketPath } from './socket.ts';
import { listenWindows } from '../../windows-pipe/src/index.mjs';
/** Same HTTP handlers on protected Windows pipes or existing Unix sockets. */
export async function listenLocal(server: Server, socketPath: string): Promise<() => Promise<void>> {
  if (process.platform === 'win32') return listenWindows(server, socketPath);
  await prepareSocketPath(socketPath);
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve)});
  await chmod(socketPath,0o600);
  return async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await unlink(socketPath).catch(()=>{});};
}
