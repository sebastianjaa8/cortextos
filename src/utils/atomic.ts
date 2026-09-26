import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readlinkSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { randomBytes } from 'crypto';

/**
 * Atomically write data to a file by writing to a temp file first,
 * then renaming. Rename is atomic on the same filesystem.
 * Matches the bash pattern: printf > .tmp.file && mv .tmp.file file
 *
 * When `keepBak` is true (default: false), the CURRENT file is copied to
 * `<filePath>.bak` before the rename.  This gives callers a single-step
 * rollback point without the cost of maintaining a full backup chain.
 * The `.bak` write is best-effort — if it fails the main write still proceeds.
 *
 * Symlink-aware: if `filePath` is a symlink (a common way to share one file
 * across several locations), the write is routed THROUGH the link to its real
 * target. A naive temp-file + rename onto the link path would replace the
 * symlink with a regular file and detach it from the shared target. For
 * non-symlinks the behavior is byte-identical to a plain atomic
 * create/overwrite.
 */
export function atomicWriteSync(filePath: string, data: string, keepBak = false): void {
  atomicWrite(filePath, data, keepBak, false);
}

/**
 * Atomic write with an fsync barrier. Use when a second durable write depends
 * on the first one surviving a host crash (for example journal-before-offset).
 */
export function atomicWriteDurableSync(filePath: string, data: string, keepBak = false): void {
  atomicWrite(filePath, data, keepBak, true);
}

function atomicWrite(filePath: string, data: string, keepBak: boolean, durable: boolean): void {
  // Resolve the rename DESTINATION. For a symlink we must write through to the
  // real target (and create the temp in the real target's dir so the rename
  // stays same-filesystem/atomic). lstat ENOENT => the path does not exist yet,
  // which is the plain atomic-create path and MUST NOT crash.
  let destPath = filePath;
  // Only the initial lstat is swallowed (path absent => plain atomic-create).
  // Resolution errors below — notably the ELOOP cycle guard — must propagate,
  // so they sit OUTSIDE this narrow try.
  let isLink = false;
  try {
    isLink = lstatSync(filePath).isSymbolicLink();
  } catch {
    // lstat ENOENT (or other lstat failure): the path itself is absent — treat
    // as a brand-new file at filePath. This is the plain atomic-create path and
    // must not throw here.
  }
  if (isLink) {
    // Resolve the link to its real target. For a DANGLING symlink (target
    // does not exist), realpathSync FOLLOWS the link and throws ENOENT. In
    // that case we must NOT fall back to filePath — that would replace the
    // symlink with a regular file via rename and detach it. Instead walk the
    // link chain hop by hop to its terminus and write THROUGH to create it,
    // leaving every link intact. A single readlink is not enough: in a chain
    // a -> b -> missing, one hop resolves only to b — itself a symlink — and
    // renaming onto b would replace THAT link with a regular file.
    try {
      destPath = realpathSync(filePath);
    } catch {
      // Dangling chain: follow each link's declared target (readlinkSync
      // returns it even when it does not exist; relative targets resolve
      // against that link's own directory) until a non-symlink or a
      // nonexistent path — the terminus where the write must land. The hop
      // cap guards against symlink cycles, mirroring the kernel's ELOOP.
      let current = filePath;
      let hops = 0;
      for (;;) {
        if (hops++ >= 40) {
          const err = new Error(`atomicWriteSync: symlink cycle or chain too deep at ${filePath}`) as NodeJS.ErrnoException;
          err.code = 'ELOOP';
          throw err;
        }
        let st2;
        try {
          st2 = lstatSync(current);
        } catch {
          break; // nonexistent — this is the terminus to create
        }
        if (!st2.isSymbolicLink()) break; // real file — write through onto it
        current = resolve(dirname(current), readlinkSync(current));
      }
      destPath = current;
    }
  }

  const dir = dirname(destPath);
  mkdirSync(dir, { recursive: true });

  // Best-effort backup of the current file before overwriting. The backup
  // SOURCE is destPath (the real current target — captures live content even
  // through a symlink), but the backup lands at `filePath + '.bak'` (the given/
  // link path) so a caller that recovers from `<given path>.bak` finds it
  // whether or not the path was a symlink. (For a non-symlink filePath ===
  // destPath, so this is byte-identical to a plain backup.)
  if (keepBak && existsSync(destPath)) {
    try {
      copyFileSync(destPath, filePath + '.bak');
    } catch {
      // Ignore backup errors — do not block the main write.
    }
  }

  const tmpPath = join(dir, `.tmp.${randomBytes(6).toString('hex')}`);
  let fd: number | undefined;
  try {
    fd = openSync(tmpPath, 'wx', 0o600);
    writeFileSync(fd, data + '\n', { encoding: 'utf-8' });
    if (durable) fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmpPath, destPath);
    if (durable) {
      try {
        const dirFd = openSync(dir, 'r');
        try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      } catch {
        // Directory handles cannot be fsynced on every Windows filesystem.
      }
    }
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    // Clean up temp file on failure
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Ensure a directory exists, creating it recursively if needed.
 */
export function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}
