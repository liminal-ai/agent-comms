// One daemon per bridge home: a lock file holding the daemon's pid, created
// exclusively. A lock left by a process that's gone is taken over.

import { open, readFile, unlink } from "node:fs/promises";

export class LockHeld extends Error {
  readonly pid: number;
  constructor(pid: number, path: string) {
    super(`another grokbot daemon (pid ${pid}) holds ${path}`);
    this.pid = pid;
  }
}

export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The pid in the lock file, if that process is still running. */
export async function lockOwner(path: string): Promise<number | null> {
  try {
    const pid = Number((await readFile(path, "utf8")).trim());
    return processAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Takes the lock; resolves with its release function. */
export async function acquireLock(path: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      return async () => {
        const owner = await readFile(path, "utf8").catch(() => "");
        if (owner.trim() === String(process.pid)) await unlink(path).catch(() => {});
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = await lockOwner(path);
      if (pid !== null && pid !== process.pid) throw new LockHeld(pid, path);
      await unlink(path).catch(() => {});
    }
  }
  throw new Error(`couldn't take the lock ${path}`);
}
