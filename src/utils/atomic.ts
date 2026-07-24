import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
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
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  // Best-effort backup of the current file before overwriting.
  if (keepBak && existsSync(filePath)) {
    try {
      copyFileSync(filePath, filePath + '.bak');
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
    renameSync(tmpPath, filePath);
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
