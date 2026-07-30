/**
 * Community Catalog Module
 * Browse, install, prepare, and submit community catalog items.
 * Node.js equivalent of bash browse-catalog.sh, install-community-item.sh,
 * prepare-submission.sh, submit-community-item.sh.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, cpSync, rmSync, chmodSync } from 'fs';
import { join, resolve, relative, isAbsolute } from 'path';
import { execSync, execFileSync } from 'child_process';
import { ensureDir } from '../utils/atomic.js';

// --- Types ---

export interface CatalogItem {
  name: string;
  description: string;
  author: string;
  type: 'skill' | 'agent' | 'org';
  version: string;
  tags: string[];
  review_status: string;
  dependencies: string[];
  install_path: string;
  submitted_at: string;
  installed?: boolean;
}

export interface CatalogBrowseResult {
  status: string;
  count: number;
  items: CatalogItem[];
  error?: string;
  hint?: string;
  message?: string;
}

export interface CatalogBrowseOptions {
  type?: string;
  tag?: string;
  search?: string;
}

export interface InstallResult {
  status: string;
  name: string;
  version?: string;
  target?: string;
  file_count?: number;
  files?: string[];
  error?: string;
  hint?: string;
  path?: string;
}

export interface PrepareResult {
  status: string;
  name: string;
  type: string;
  staging_dir: string;
  file_count: number;
  files: string[];
  pii_detected: string[];
  /**
   * WHICH CHECKS ACTUALLY RAN, and which could not, BY NAME.
   *
   * Added 2026-07-30 after `prepareSubmission` was found reporting `status: 'clean'` while two of
   * its checks had never executed: `orgContext` and `userNames` gate the company-name and
   * person-name scans, and the only production caller passed neither. Those two keys were supplied
   * ONLY by the test suite — so the tests proved the checks WORK while nothing in production could
   * reach them, and a green suite concealed a dead feature in the scanner that gates PUBLIC
   * submission.
   *
   * `clean` from a scanner that silently skipped half its checks is a claim, not a result. A
   * scanner that NAMES its own blind spot is more trustworthy than one with an unqualified pass —
   * the same property that makes croncheck's NO_EXPECTATION count useful.
   */
  checks_run: string[];
  checks_skipped: { check: string; reason: string }[];
}

export interface SubmitResult {
  status: string;
  name: string;
  branch?: string;
  pr_url?: string;
  target?: string;
  description?: string;
  file_count?: number;
  error?: string;
  hint?: string;
}

// --- PII Patterns ---

const PII_PATTERNS = {
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
  phone: /\+?[0-9]{1,3}[-.\s]?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/,
  credential: /(sk-|ghp_|xoxb-|AKIA|token=|key=|password=|secret=)/,
  telegram_chat_id: /chat_id[:\s]*[0-9]{6,}/,
  deployment_url: /https?:\/\/[a-z0-9.-]+\.(railway\.app|vercel\.app|herokuapp\.com|netlify\.app)/,
};

/**
 * Whole-name, case-insensitive match. NOT a substring test.
 *
 * The previous implementation was `content.toLowerCase().includes(name.toLowerCase())`, which for a
 * real name list is a false-positive generator: a short surname matches every longer word that
 * contains it, and a short name matches any URL containing those letters. A PII scanner that cries
 * wolf gets its output scrolled past — and unlike a cron report, the thing being scrolled past here
 * is the last gate before a public repo.
 *
 * Multi-word names are matched WHOLE, never split, so neither half can fire alone.
 * Internal whitespace is allowed to span a line break or repeated spaces, since a name wrapped by a
 * formatter is still the name.
 */
export function matchesWholeName(content: string, name: string): boolean {
  // ZERO BACKSLASHES ON PURPOSE. Three attempts to write this with a regex each lost a backslash
  // in transit and shipped a broken character class; the fix is to need none. Whitespace is
  // collapsed by comparing against the space character rather than by a class escape.
  const norm = (s: string) =>
    Array.from(s.toLowerCase(), (c) => (c <= ' ' ? ' ' : c))
      .join('')
      .split(' ')
      .filter(Boolean)
      .join(' ');
  const needle = norm(name);
  if (!needle) return false;
  const hay = norm(content);
  const WORD_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789_';
  const isWord = (ch: string | undefined) => ch !== undefined && WORD_CHARS.includes(ch);
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i === -1) return false;
    // Boundary on BOTH sides, so a short name cannot fire inside a longer word.
    if (!isWord(hay[i - 1]) && !isWord(hay[i + needle.length])) return true;
    from = i + 1;
  }
}

/**
 * The names to scan for, read from LOCAL config that never enters this repo.
 *
 * `<ctxRoot>/config/pii-names.json` — outside the source tree by construction, so the list of names
 * we are trying to keep OUT of a public repo cannot itself be committed into one. There is
 * deliberately no committed default file and no fallback list in code: a hardcoded name here would
 * ship to the community catalogue on the next submission, which is the exact failure this scanner
 * exists to prevent.
 *
 * Absent or unreadable returns [], and the caller reports `user_name` in `checks_skipped` by name.
 * Adding a name is a config edit, never a code change.
 */
export function loadPiiNames(ctxRoot: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(ctxRoot, 'config', 'pii-names.json'), 'utf-8'));
    const names = Array.isArray(raw) ? raw : raw?.names;
    return Array.isArray(names) ? names.filter((n) => typeof n === 'string' && n.trim()) : [];
  } catch {
    return [];
  }
}

// --- Item name validation ---

function isValidItemName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

function lockdownPermissions(targetDir: string): void {
  if (process.platform === 'win32') return;
  try {
    const walk = (dir: string) => {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          chmodSync(full, 0o700);
          walk(full);
        } else if (entry.isFile()) {
          // Preserve executability for shell scripts, lock everything else to 0600
          const isExec = entry.name.endsWith('.sh') || entry.name.endsWith('.mjs') || entry.name.endsWith('.py');
          chmodSync(full, isExec ? 0o700 : 0o600);
        }
      }
    };
    chmodSync(targetDir, 0o700);
    walk(targetDir);
  } catch {
    // best effort; not fatal
  }
}

// --- Catalog path resolution ---

function findCatalogPath(frameworkRoot: string): string {
  return join(frameworkRoot, 'community', 'catalog.json');
}

function isInsideDir(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

function getInstalledPath(ctxRoot: string): string {
  return join(ctxRoot, '.installed-community.json');
}

function readInstalled(ctxRoot: string): Record<string, { version: string; type: string; installed_at: string; path: string }> {
  const p = getInstalledPath(ctxRoot);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

function writeInstalled(ctxRoot: string, data: Record<string, unknown>): void {
  const p = getInstalledPath(ctxRoot);
  ensureDir(ctxRoot);
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

// --- browseCatalog ---

export function browseCatalog(
  frameworkRoot: string,
  ctxRoot: string,
  options: CatalogBrowseOptions = {},
): CatalogBrowseResult {
  const catalogPath = findCatalogPath(frameworkRoot);

  if (!existsSync(catalogPath)) {
    return { status: 'error', count: 0, items: [], error: 'catalog.json not found', hint: 'Run check-upstream to fetch the latest catalog' };
  }

  let catalog: { items: CatalogItem[] };
  try {
    catalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));
  } catch {
    return { status: 'error', count: 0, items: [], error: 'Failed to parse catalog.json' };
  }

  if (!catalog.items || catalog.items.length === 0) {
    return { status: 'empty', count: 0, items: [], message: 'No items in catalog yet' };
  }

  let items = [...catalog.items];

  // Filter by type
  if (options.type) {
    items = items.filter(i => i.type === options.type);
  }

  // Filter by tag
  if (options.tag) {
    items = items.filter(i => i.tags && i.tags.includes(options.tag!));
  }

  // Filter by search (name or description, case-insensitive)
  if (options.search) {
    const q = options.search.toLowerCase();
    items = items.filter(i =>
      i.name.toLowerCase().includes(q) ||
      (i.description && i.description.toLowerCase().includes(q)),
    );
  }

  // Enrich with installed status
  const installed = readInstalled(ctxRoot);
  items = items.map(i => ({
    ...i,
    installed: installed[i.name] != null,
  }));

  return { status: 'ok', count: items.length, items };
}

// --- installCommunityItem ---

export function installCommunityItem(
  frameworkRoot: string,
  ctxRoot: string,
  itemName: string,
  options: { dryRun?: boolean; agentDir?: string } = {},
): InstallResult {
  if (!itemName) {
    return { status: 'error', name: '', error: 'item name required' };
  }

  if (!isValidItemName(itemName)) {
    return { status: 'error', name: itemName, error: 'invalid item name (allowed: a-zA-Z0-9 _ -)' };
  }

  const catalogPath = findCatalogPath(frameworkRoot);
  if (!existsSync(catalogPath)) {
    return { status: 'error', name: itemName, error: 'catalog.json not found' };
  }

  let catalog: { items: CatalogItem[] };
  try {
    catalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));
  } catch {
    return { status: 'error', name: itemName, error: 'Failed to parse catalog.json' };
  }

  const item = catalog.items.find(i => i.name === itemName);
  if (!item) {
    return { status: 'error', name: itemName, error: 'item not found in catalog' };
  }

  // Normalize install_path: strip an optional leading "community/" so entries
  // authored as either "community/skills/X" (shipped catalog shape) or
  // "skills/X" (submit-writes shape) both resolve correctly under communityBase.
  const installPath = item.install_path.replace(/^community\//, '');

  // Validate install_path to prevent path traversal
  if (installPath.includes('..') || isAbsolute(installPath)) {
    return { status: 'error', name: itemName, error: 'install_path contains path traversal' };
  }

  const communityBase = join(frameworkRoot, 'community');
  const sourceDir = join(communityBase, installPath);

  // Verify resolved path is under community/
  if (!isInsideDir(communityBase, sourceDir)) {
    return { status: 'error', name: itemName, error: 'install_path resolves outside community directory' };
  }

  if (!existsSync(sourceDir)) {
    return { status: 'error', name: itemName, error: 'source directory not found', hint: 'Run check-upstream to fetch latest catalog' };
  }

  // Determine target based on type
  let targetDir: string;
  switch (item.type) {
    case 'skill':
      // Skills must land under .claude/skills/ because that is where the
      // Claude Code harness actually discovers them. Writing to a bare
      // skills/ directory meant installs silently didn't load without a
      // manual cp into .claude/skills/ after the fact.
      targetDir = join(options.agentDir || frameworkRoot, '.claude', 'skills', itemName);
      break;
    case 'agent':
      targetDir = join(frameworkRoot, 'templates', 'personas', itemName);
      break;
    case 'org':
      targetDir = join(frameworkRoot, 'templates', 'orgs', itemName);
      break;
    default:
      return { status: 'error', name: itemName, error: `unknown item type: ${item.type}` };
  }

  // Check for existing installation
  if (existsSync(targetDir)) {
    return { status: 'already_exists', name: itemName, path: targetDir, hint: 'Remove existing directory first or merge manually' };
  }

  // List files
  const files = listFilesRecursive(sourceDir, sourceDir);

  if (options.dryRun) {
    return {
      status: 'dry_run',
      name: itemName,
      version: item.version,
      target: targetDir,
      file_count: files.length,
      files,
    };
  }

  // Install: copy files
  ensureDir(targetDir);
  cpSync(sourceDir, targetDir, { recursive: true });
  lockdownPermissions(targetDir);

  // Record installation
  const installed = readInstalled(ctxRoot);
  installed[itemName] = {
    version: item.version,
    type: item.type,
    installed_at: new Date().toISOString(),
    path: targetDir,
  };
  writeInstalled(ctxRoot, installed);

  return {
    status: 'installed',
    name: itemName,
    version: item.version,
    target: targetDir,
    file_count: files.length,
  };
}

// --- prepareSubmission ---

export function prepareSubmission(
  ctxRoot: string,
  itemType: string,
  sourcePath: string,
  itemName: string,
  options: { dryRun?: boolean; orgContext?: { name?: string }; userNames?: string[] } = {},
): PrepareResult {
  if (!itemType || !sourcePath || !itemName) {
    return { status: 'error', name: itemName || '', type: itemType || '', staging_dir: '', file_count: 0, files: [], checks_run: [], checks_skipped: [{ check: 'all', reason: 'aborted before scanning' }], pii_detected: ['usage: prepare-submission <skill|agent|org> <source-path> <item-name>'] };
  }

  if (!isValidItemName(itemName)) {
    return { status: 'error', name: itemName, type: itemType, staging_dir: '', file_count: 0, files: [], checks_run: [], checks_skipped: [{ check: 'all', reason: 'aborted before scanning' }], pii_detected: ['invalid item name (allowed: a-zA-Z0-9 _ -)'] };
  }

  if (!existsSync(sourcePath)) {
    return { status: 'error', name: itemName, type: itemType, staging_dir: '', file_count: 0, files: [], checks_run: [], checks_skipped: [{ check: 'all', reason: 'aborted before scanning' }], pii_detected: ['source path not found'] };
  }

  // Staging directory
  const stagingDir = join(ctxRoot, 'community-staging', itemName);

  // Verify staging path is under community-staging/
  if (!isInsideDir(join(ctxRoot, 'community-staging'), stagingDir)) {
    return { status: 'error', name: itemName, type: itemType, staging_dir: '', file_count: 0, files: [], checks_run: [], checks_skipped: [{ check: 'all', reason: 'aborted before scanning' }], pii_detected: ['staging directory resolves outside expected path'] };
  }

  // Clean and create staging
  if (existsSync(stagingDir)) {
    rmSync(stagingDir, { recursive: true, force: true });
  }
  ensureDir(stagingDir);

  // Copy source to staging
  cpSync(sourcePath, stagingDir, { recursive: true });
  lockdownPermissions(stagingDir);

  // PII scanning
  const piiFound: string[] = [];
  const files = listFilesRecursive(stagingDir, stagingDir);

  for (const relPath of files) {
    const fullPath = join(stagingDir, relPath);
    let content: string;
    try {
      content = readFileSync(fullPath, 'utf-8');
    } catch {
      continue; // skip binary or unreadable files
    }

    if (PII_PATTERNS.email.test(content)) {
      piiFound.push(`${relPath}:email_address`);
    }

    if (PII_PATTERNS.phone.test(content)) {
      piiFound.push(`${relPath}:phone_number`);
    }

    if (PII_PATTERNS.credential.test(content)) {
      piiFound.push(`${relPath}:credential_pattern`);
    }

    if (PII_PATTERNS.telegram_chat_id.test(content)) {
      piiFound.push(`${relPath}:telegram_chat_id`);
    }

    if (PII_PATTERNS.deployment_url.test(content)) {
      piiFound.push(`${relPath}:deployment_url`);
    }

    // Check for known user names
    if (options.userNames) {
      for (const name of options.userNames) {
        if (matchesWholeName(content, name)) {
          piiFound.push(`${relPath}:user_name:${name}`);
        }
      }
    }

    // Check for company name
    if (options.orgContext?.name) {
      if (matchesWholeName(content, options.orgContext.name)) {
        piiFound.push(`${relPath}:company_name:${options.orgContext.name}`);
      }
    }
  }

  if (options.dryRun) {
    rmSync(stagingDir, { recursive: true, force: true });
  }

  // DERIVED FROM PII_PATTERNS, not typed. My first version of this line listed
  // ['email','api_key','absolute_path','ip_address','deployment_url'] — three of which DO NOT
  // EXIST — because I wrote the inventory from memory instead of from the code, inside the very
  // change whose purpose was to stop this scanner overstating what it checked. Narrated is not
  // measured, committed in the honesty fix. Deriving it means the report cannot drift from what
  // actually runs, and adding a pattern updates the report for free.
  const checksRun = Object.keys(PII_PATTERNS);
  const checksSkipped: { check: string; reason: string }[] = [];
  if (options.userNames && options.userNames.length > 0) checksRun.push('user_name');
  else checksSkipped.push({ check: 'user_name', reason: 'no userNames supplied by the caller — personal names were NOT scanned for' });
  if (options.orgContext?.name) checksRun.push('company_name');
  else checksSkipped.push({ check: 'company_name', reason: 'no orgContext.name supplied by the caller — the org name was NOT scanned for' });

  return {
    // `clean` would overstate a partial scan. A pass with skipped checks is PARTIAL, and the
    // distinction is the whole point: the previous version reported 'clean' having never run two
    // of its checks.
    status: piiFound.length > 0 ? 'pii_detected' : (checksSkipped.length > 0 ? 'clean_partial' : 'clean'),
    name: itemName,
    type: itemType,
    staging_dir: stagingDir,
    file_count: files.length,
    files,
    pii_detected: piiFound,
    checks_run: checksRun,
    checks_skipped: checksSkipped,
  };
}

// --- submitCommunityItem ---

export function submitCommunityItem(
  frameworkRoot: string,
  ctxRoot: string,
  itemName: string,
  itemType: string,
  description: string,
  options: { dryRun?: boolean; author?: string; contribute?: boolean } = {},
): SubmitResult {
  if (!itemName || !itemType || !description) {
    return { status: 'error', name: itemName || '', error: 'usage: submit-community-item <item-name> <item-type> <description>' };
  }

  if (!isValidItemName(itemName)) {
    return { status: 'error', name: itemName, error: 'invalid item name (allowed: a-zA-Z0-9 _ -)' };
  }

  if (!['skill', 'agent', 'org'].includes(itemType)) {
    return { status: 'error', name: itemName, error: 'invalid type, must be: skill, agent, org' };
  }

  const stagingDir = join(ctxRoot, 'community-staging', itemName);
  if (!existsSync(stagingDir)) {
    return { status: 'error', name: itemName, error: 'staged submission not found', hint: 'Run prepare-submission first' };
  }

  // Target path in the repo
  let installPath: string;
  switch (itemType) {
    case 'skill': installPath = `skills/${itemName}`; break;
    case 'agent': installPath = `agents/${itemName}`; break;
    case 'org':   installPath = `orgs/${itemName}`; break;
    default:      return { status: 'error', name: itemName, error: 'invalid type' };
  }

  const targetDir = join(frameworkRoot, 'community', installPath);
  const files = listFilesRecursive(stagingDir, stagingDir);
  const branch = `community/${itemName}`;
  const author = options.author || 'anonymous';

  if (options.dryRun) {
    return {
      status: 'dry_run',
      name: itemName,
      target: `community/${installPath}`,
      description,
      file_count: files.length,
      branch,
    };
  }

  // Copy staged files to community directory
  ensureDir(targetDir);
  cpSync(stagingDir, targetDir, { recursive: true });
  lockdownPermissions(targetDir);

  // Update catalog.json
  const catalogPath = join(frameworkRoot, 'community', 'catalog.json');
  let catalog: { version: string; updated_at: string; items: CatalogItem[] };
  try {
    catalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));
  } catch {
    catalog = { version: '1.0.0', updated_at: new Date().toISOString(), items: [] };
  }

  const timestamp = new Date().toISOString();
  catalog.items.push({
    name: itemName,
    description,
    author,
    type: itemType as 'skill' | 'agent' | 'org',
    version: '1.0.0',
    tags: [],
    review_status: 'community',
    dependencies: [],
    install_path: installPath,
    submitted_at: timestamp,
  });

  writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n', 'utf-8');

  // Clean up staging
  rmSync(stagingDir, { recursive: true, force: true });

  // --contribute: create branch, commit, push to origin, open PR against upstream
  if (options.contribute) {
    const execOpts = { cwd: frameworkRoot, encoding: 'utf-8' as const, timeout: 60000 };

    try {
      // Verify upstream remote exists
      let upstreamUrl: string;
      try {
        upstreamUrl = (execSync('git remote get-url upstream', { ...execOpts, stdio: 'pipe' }) as string).trim();
      } catch {
        return {
          status: 'error', name: itemName,
          error: 'no upstream remote configured',
          hint: 'Run: git remote add upstream <canonical-repo-url>',
        };
      }

      // Verify origin remote exists
      try {
        execSync('git remote get-url origin', { ...execOpts, stdio: 'pipe' });
      } catch {
        return {
          status: 'error', name: itemName,
          error: 'no origin remote configured',
          hint: 'Add your fork as origin: git remote add origin <your-fork-url>',
        };
      }

      // Create and switch to contribution branch (from current HEAD)
      try {
        execFileSync('git', ['checkout', '-b', branch], { ...execOpts, stdio: 'pipe' });
      } catch {
        // Branch may already exist — switch to it
        execFileSync('git', ['checkout', branch], { ...execOpts, stdio: 'pipe' });
      }

      // Stage the new community files and updated catalog
      execSync('git add community/', { ...execOpts, stdio: 'pipe' });

      // Commit
      const commitMsg = `community: add ${itemType} ${itemName}\n\n${description}\n\nSubmitted-by: ${author}`;
      execFileSync('git', ['commit', '-m', commitMsg], { ...execOpts, stdio: 'pipe' });

      // Push to origin
      execFileSync('git', ['push', 'origin', branch], { ...execOpts, stdio: 'pipe' });

      // Extract upstream repo (owner/repo) from upstream remote URL
      const upstreamRepo = extractRepoPath(upstreamUrl);

      // Open PR via gh CLI
      let prUrl = '';
      try {
        const prTitle = `Community ${itemType}: ${itemName}`;
        const prBody = `## ${itemName}\n\n${description}\n\n**Type:** ${itemType}\n**Author:** ${author}\n\n---\n*Submitted via cortextOS community publishing*`;
        const ghOut = (execFileSync(
          'gh',
          ['pr', 'create', '--repo', upstreamRepo, '--title', prTitle, '--body', prBody],
          { ...execOpts, stdio: 'pipe', encoding: 'utf-8' },
        ) as string).trim();
        prUrl = ghOut.split('\n').find((l: string) => l.startsWith('https://')) || ghOut;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          status: 'contributed',
          name: itemName,
          branch,
          file_count: files.length,
          hint: `Branch pushed to origin/${branch} but gh pr create failed: ${msg.split('\n')[0]}. Open the PR manually.`,
        };
      }

      return {
        status: 'contributed',
        name: itemName,
        branch,
        pr_url: prUrl,
        file_count: files.length,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { status: 'error', name: itemName, error: `contribution failed: ${msg.split('\n')[0]}` };
    }
  }

  return {
    status: 'submitted',
    name: itemName,
    file_count: files.length,
  };
}

// --- Helpers ---

/** Extract "owner/repo" from a git remote URL (https or ssh) */
function extractRepoPath(remoteUrl: string): string {
  // https://github.com/owner/repo.git  or  git@github.com:owner/repo.git
  const match = remoteUrl.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return match ? match[1] : remoteUrl;
}

function listFilesRecursive(dir: string, baseDir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...listFilesRecursive(fullPath, baseDir));
      } else {
        results.push(relative(baseDir, fullPath));
      }
    }
  } catch {
    // Directory not readable
  }

  return results.sort();
}
