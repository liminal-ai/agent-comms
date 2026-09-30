// The connector's socket directory is the loopback protocol's only
// protection: owner-only, owned by us, never a symlink. Shared by the stub and
// (later) the real connector.

import { lstat, mkdir, unlink } from "node:fs/promises";
import { connect } from "node:net";
import { dirname } from "node:path";

export class SocketDirError extends Error {}

export async function prepareSocketPath(socketPath: string): Promise<void> {
  const dir = dirname(socketPath);
  const uid = process.getuid?.();
  try {
    const st = await lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new SocketDirError(`${dir} exists and is not a plain directory; refusing to start`);
    }
    if (uid !== undefined && st.uid !== uid) {
      throw new SocketDirError(`${dir} is owned by uid ${st.uid}, not ${uid}; refusing to start`);
    }
    if ((st.mode & 0o077) !== 0) {
      const mode = (st.mode & 0o777).toString(8).padStart(4, "0");
      throw new SocketDirError(`${dir} has mode ${mode}; it must be 0700 (owner only); refusing to start`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // mkdir's mode is filtered by the umask; 0700 survives any sane umask, and we re-check below.
    await mkdir(dir, { mode: 0o700 });
    const st = await lstat(dir);
    if ((st.mode & 0o077) !== 0) throw new SocketDirError(`created ${dir} but it isn't 0700`);
  }

  if (await isListening(socketPath)) {
    throw new SocketDirError(`something is already listening on ${socketPath}; is another connector running?`);
  }
  await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

function isListening(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}
