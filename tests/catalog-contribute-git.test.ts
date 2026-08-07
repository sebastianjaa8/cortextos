import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { submitCommunityItem } from '../src/bus/catalog.js';

/**
 * Covers 2 of the 3 behaviours in submitCommunityItem's --contribute path: branch
 * checkout/reuse and the git-commit "nothing to commit" skip. Both are pure git,
 * so they run against a real local bare repo standing in for `origin` — no
 * network, no gh.
 *
 * The third behaviour, `gh pr create` "already exists" detection, is deliberately
 * NOT covered here — it calls real gh under a real GitHub account and stays
 * gated on Sebastian's approval (task_1786055215058_89123912). A stub `gh` is
 * used ONLY so the unconditional
 * post-push `gh pr create` call in submitCommunityItem doesn't hang or hit the
 * network while these two behaviours run through the real function end-to-end —
 * its output is never asserted on.
 */
describe('submitCommunityItem --contribute: git-only idempotency (no gh, no network)', () => {
  const testDir = join(tmpdir(), `cortextos-contribute-git-${Date.now()}`);
  const frameworkRoot = join(testDir, 'framework');
  const ctxRoot = join(testDir, 'ctx');
  const originBare = join(testDir, 'origin.git');
  const upstreamBare = join(testDir, 'upstream.git');
  const fakeBinDir = join(testDir, 'fake-bin');
  let originalPath: string | undefined;

  function git(args: string, cwd: string) {
    return execSync(`git ${args}`, { cwd, stdio: 'pipe', encoding: 'utf-8' });
  }

  function stageItem(description: string) {
    const stagingDir = join(ctxRoot, 'community-staging', 'test-item');
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, 'SKILL.md'), `---\nname: test-item\n---\n${description}`, 'utf-8');
  }

  beforeEach(() => {
    mkdirSync(join(frameworkRoot, 'community'), { recursive: true });
    mkdirSync(ctxRoot, { recursive: true });
    writeFileSync(join(frameworkRoot, 'community', 'catalog.json'), JSON.stringify({ version: '1.0.0', items: [] }), 'utf-8');

    git('init', frameworkRoot);
    git('config user.email "test@test.com"', frameworkRoot);
    git('config user.name "Test"', frameworkRoot);
    writeFileSync(join(frameworkRoot, '.gitkeep'), '', 'utf-8');
    git('add .gitkeep community/catalog.json', frameworkRoot);
    git('commit -m init', frameworkRoot);

    // Local bare repos — real git remotes, zero network.
    mkdirSync(originBare, { recursive: true });
    execSync('git init --bare', { cwd: originBare, stdio: 'pipe' });
    mkdirSync(upstreamBare, { recursive: true });
    execSync('git init --bare', { cwd: upstreamBare, stdio: 'pipe' });
    git(`remote add origin "${originBare.replace(/\\/g, '/')}"`, frameworkRoot);
    git(`remote add upstream "${upstreamBare.replace(/\\/g, '/')}"`, frameworkRoot);

    // Stub `gh` so the unconditional post-push call resolves instead of hanging
    // on a missing binary or hitting the network. Its output is never asserted.
    mkdirSync(fakeBinDir, { recursive: true });
    const ghStub = join(fakeBinDir, 'gh.cmd');
    writeFileSync(ghStub, '@echo off\r\necho error: stub gh, no real PR created 1>&2\r\nexit /b 1\r\n', 'utf-8');
    chmodSync(ghStub, 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = `${fakeBinDir}${process.platform === 'win32' ? ';' : ':'}${originalPath}`;

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-07T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalPath !== undefined) process.env.PATH = originalPath;
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('creates the branch and commits on the first contribute', () => {
    stageItem('v1');
    const result = submitCommunityItem(frameworkRoot, ctxRoot, 'test-item', 'skill', 'First run', {
      contribute: true,
      author: 'tester',
    });

    expect(result.status).toBe('contributed');
    expect(result.branch).toBe('community/test-item');

    const branch = git('branch --show-current', frameworkRoot).trim();
    expect(branch).toBe('community/test-item');

    const log = git('log --oneline', frameworkRoot).trim().split('\n');
    expect(log.length).toBe(2); // init + this commit
  });

  it('reuses the existing branch instead of erroring on a second contribute', () => {
    stageItem('v1');
    submitCommunityItem(frameworkRoot, ctxRoot, 'test-item', 'skill', 'First run', { contribute: true, author: 'tester' });

    stageItem('v1'); // identical content — re-stage since submit consumes the staging dir
    const result = submitCommunityItem(frameworkRoot, ctxRoot, 'test-item', 'skill', 'First run', { contribute: true, author: 'tester' });

    // Pre-fix this branch would never be reached the same way (checkout -b would
    // fail and, before the fix, whatever came after would still run — the actual
    // regression this guards is the commit step below, not branch selection,
    // but asserting branch identity here confirms `checkout -b` -> `checkout`
    // fallback actually landed us back on the right branch rather than erroring
    // out of the whole call.
    expect(result.status).toBe('contributed');
    expect(result.branch).toBe('community/test-item');
    const branch = git('branch --show-current', frameworkRoot).trim();
    expect(branch).toBe('community/test-item');
  });

  it('does not error when the second contribute has nothing new to commit', () => {
    stageItem('v1');
    submitCommunityItem(frameworkRoot, ctxRoot, 'test-item', 'skill', 'First run', { contribute: true, author: 'tester' });
    const shaAfterFirst = git('rev-parse HEAD', frameworkRoot).trim();

    // Same description, same author, same file content, frozen clock (same
    // submitted_at) -> catalog.json and community/ end up byte-identical to what
    // is already committed on this branch, so `git commit` genuinely has nothing
    // to commit. Before the fix this surfaced as status: 'error'.
    stageItem('v1');
    const result = submitCommunityItem(frameworkRoot, ctxRoot, 'test-item', 'skill', 'First run', { contribute: true, author: 'tester' });

    expect(result.status).toBe('contributed');
    const shaAfterSecond = git('rev-parse HEAD', frameworkRoot).trim();
    expect(shaAfterSecond).toBe(shaAfterFirst); // no new commit was created

    const log = git('log --oneline', frameworkRoot).trim().split('\n');
    expect(log.length).toBe(2); // still just init + the one real commit
  });
});
