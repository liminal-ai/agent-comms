// The local service's private data directory: the SQLite store and the two
// credentials it generates on first start (the admin token for the web view
// and admin commands, and the in-process connector's machine secret). Nothing
// here is ever printed except on an explicit `web-url`.
//
// First start is recoverable as a unit. The credentials are written under
// temporary names, the store is created with their hashes in one transaction,
// then the files take their final names. A crash before the store commits
// leaves only temporary files (replaced on the next start); a crash after it
// leaves files the store's hashes identify (finished on the next start).
// Credential files that no store vouches for are never adopted.

import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { privateWindowsDirectory, protectPrivateWindowsFile, readPrivateWindowsSecret } from "../../windows-pipe/src/secret.mjs";

export const STORE_FILE = "comms.sqlite";
export const ADMIN_TOKEN_FILE = "admin.token";
export const MACHINE_SECRET_FILE = "machine.secret";
export const CREDENTIALS = [ADMIN_TOKEN_FILE, MACHINE_SECRET_FILE] as const;

const pendingName = (name: string) => `.${name}.init`;
const metaKey = (name: string) => `sha256:${name}`;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * Creates the directory owner-only, or checks an existing one is, before the
 * store or any credential is written in it. Windows: a new or empty directory
 * is given a private DACL that everything inside inherits; a non-empty one
 * must already have one.
 */
export function prepareDataDir(dir: string): void {
  const created = !existsSync(dir);
  if (created) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} isn't a plain directory; refusing to use it`);
  if (process.platform === "win32") {
    const mode = created || readdirSync(dir).length === 0 ? "protect" : "check";
    if (!privateWindowsDirectory(dir, mode)) throw new Error(`${dir} isn't private to the current Windows user (owner, inheritance off, only the user's access); refusing to use it`);
    return;
  }
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) throw new Error(`${dir} is owned by uid ${st.uid}, not ${uid}; refusing to use it`);
  if (st.mode & 0o077) throw new Error(`${dir} has mode ${(st.mode & 0o777).toString(8)}; it must be owner-only (chmod 700)`);
}

/**
 * For a store being created (called under its lock): fresh credentials under
 * temporary names, and the hashes to record with the store.
 */
export function stageCredentials(dir: string): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const name of CREDENTIALS) {
    if (existsSync(join(dir, name))) {
      throw new Error(`${join(dir, name)} exists but there's no store for it; refusing to adopt a credential from elsewhere (move it away)`);
    }
    const pending = join(dir, pendingName(name));
    // Ours by name: left by a first start that never committed its store.
    rmSync(pending, { force: true });
    const value = randomBytes(32).toString("base64url");
    const fd = openSync(pending, "wx", 0o600);
    try {
      writeSync(fd, value + "\n");
      // On disk before the store records its hash (the store commits with synchronous=FULL).
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (process.platform === "win32") protectPrivateWindowsFile(pending);
    meta[metaKey(name)] = sha256(value);
  }
  syncDir(dir);
  return meta;
}

/** A credential of an existing store: finishes a first start if needed, then reads and checks it. */
export function settleCredential(dir: string, name: string, storeMeta: (key: string) => string | undefined): string {
  const expected = storeMeta(metaKey(name));
  if (!expected) throw new Error(`the store records no ${name}; refusing to use it`);
  const path = join(dir, name);
  const pending = join(dir, pendingName(name));
  if (!existsSync(path)) {
    if (existsSync(pending) && sha256(readCredential(pending)) === expected) {
      renameSync(pending, path);
      syncDir(dir);
    }
    else throw new Error(`${path} is missing; the store can't be used without it`);
  }
  const value = readCredential(path);
  if (sha256(value) !== expected) throw new Error(`${path} doesn't belong to this store; refusing to use it`);
  rmSync(pending, { force: true });
  return value;
}

/** Reads a credential the admin commands need; the running service has already checked it. */
export function credential(dir: string, name: string): string {
  return readCredential(join(dir, name));
}

/** Makes renames and new entries in a directory durable (POSIX; Windows can't open a directory to sync it). */
function syncDir(dir: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readCredential(path: string): string {
  if (process.platform === "win32") return readPrivateWindowsSecret(path).trim();
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error(`${path} isn't a plain file`);
  if (st.mode & 0o077) throw new Error(`${path} has mode ${(st.mode & 0o777).toString(8)}; it must be 600`);
  const value = readFileSync(path, "utf8").trim();
  if (value.length < 32) throw new Error(`${path} is too short to be a generated credential`);
  return value;
}
