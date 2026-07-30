/**
 * Copy crons.json aside before the one migration write that can destroy live state, and
 * VERIFY the copy landed.
 *
 * This lives in its own module for one reason: the abort-on-unverified-snapshot branch in
 * cron-migration.ts guards an irreversible write, so it has to be exercised by a test rather
 * than reasoned about. Making the filesystem refuse a write portably is not possible here —
 * chmod on a directory does not block writes on Windows, which silently turned the first
 * version of that test into a vacuous pass. A separate module can be mocked, so the failure
 * path is reachable on every platform.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';

/**
 * @returns true only when the snapshot file exists and is non-empty afterwards.
 *
 * Deliberately verifies the ARTIFACT rather than trusting the call to have worked. A backup
 * nobody checked is not a backup: on 2026-07-28 a backup written inside the tree being edited
 * silently became a copy of the post-change state, which reads as safe and is worse than
 * having none.
 */
export function snapshotLiveCrons(livePath: string, snapshotPath: string): boolean {
  writeFileSync(snapshotPath, readFileSync(livePath, 'utf-8'), 'utf-8');
  return existsSync(snapshotPath) && readFileSync(snapshotPath, 'utf-8').trim().length > 0;
}
