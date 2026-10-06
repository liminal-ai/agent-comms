// One daemon per bridge home: a lock file holding the daemon's pid. It appears
// complete or not at all (written to a private temporary file, then hard-linked
// into place), so a reader never sees a half-made lock. A lock left by a process
// that's gone is taken over, one taker at a time.

import { randomBytes } from "node:crypto";
import { link, open, readFile, stat, unlink, writeFile } from "node:fs/promises";

export class LockHeld extends Error {
  readonly pid: number;
  constructor(pid: number, path: string) {
    super(`another grokbot daemon (pid ${pid}) holds ${path}`);
    this.pid = pid;
  }
}

/** An unreadable lock or takeover marker this old is debris from a crash, not a live start. */
const DEBRIS_MS = 10_000;

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
  const mine = `${process.pid}\n`;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await create(path, mine)) {
      return async () => {
        const owner = await readFile(path, "utf8").catch(() => "");
        if (owner === mine) await unlink(path).catch(() => {});
      };
    }
    const seen = await readFile(path, "utf8").catch(() => null);
    if (seen === null) continue; // released meanwhile: try again
    const pid = Number(seen.trim());
    if (seen.trim() !== "" && processAlive(pid) && pid !== process.pid) throw new LockHeld(pid, path);
    // An empty lock is a pre-atomic version's start; live unless it's old.
    if (seen.trim() === "" && !(await olderThan(path, DEBRIS_MS))) throw new Error(`${path} is being created by another start; try again`);
    await takeOver(path, seen);
  }
  throw new Error(`couldn't take the lock ${path}`);
}

/** Creates the lock with its content in one step; false if it exists. */
async function create(path: string, content: string): Promise<boolean> {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}`;
  await writeFile(tmp, content, { mode: 0o600, flag: "wx" });
  try {
    await link(tmp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/**
 * Removes a dead owner's lock, holding a takeover marker so two starts can't
 * both remove it (the second would remove the first's new lock). Only the
 * exact content judged dead is removed.
 */
async function takeOver(path: string, dead: string): Promise<void> {
  const marker = `${path}.takeover`;
  let handle;
  try {
    handle = await open(marker, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await olderThan(marker, DEBRIS_MS)) await unlink(marker).catch(() => {});
    return; // another start is taking over: the caller tries again
  }
  try {
    if ((await readFile(path, "utf8").catch(() => null)) === dead) await unlink(path).catch(() => {});
  } finally {
    await handle.close();
    await unlink(marker).catch(() => {});
  }
}

async function olderThan(path: string, ms: number): Promise<boolean> {
  try {
    return Date.now() - (await stat(path)).mtimeMs > ms;
  } catch {
    return false;
  }
}
