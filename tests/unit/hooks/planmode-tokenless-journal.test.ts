/**
 * The planmode hook auto-approves a plan when the agent has no Telegram
 * credentials. That is deliberate -- there is nobody to ask -- but it used to
 * leave no trace at all.
 *
 * Why this test exists: the first next-cycle check on the outbound journal
 * found zero `hook:planmode` records in 19h and could not distinguish "the
 * hook never fired" from "the hook fired and returned before the send". The
 * credential check sits BEFORE the journalled TelegramAPI is constructed, and
 * 9 of the 13 agents carrying this hook have no token -- so the untraced
 * branch was the common one, and a zero count read as healthy.
 *
 * The hook is run as a subprocess because its module calls main() at import
 * time and outputDecision() ends in process.exit(0); importing it would take
 * the test runner down with it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

const REPO = join(__dirname, '..', '..', '..');
const TSX = join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const HOOK = join(REPO, 'src', 'hooks', 'hook-planmode-telegram.ts');

/**
 * A scrubbed env. Inheriting process.env would let a real BOT_TOKEN on this
 * box push the hook down the send path, and the test would pass by never
 * reaching the branch it exists to cover.
 */
function runHook(opts: { ctxRoot: string; agentDir: string; planFile?: string }) {
  return spawnSync(process.execPath, [TSX, HOOK], {
    input: JSON.stringify({
      tool_name: 'ExitPlanMode',
      tool_input: opts.planFile ? { plan_file: opts.planFile } : {},
    }),
    encoding: 'utf-8',
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      CTX_AGENT_NAME: 'a1',
      CTX_ROOT: opts.ctxRoot,
      CTX_AGENT_DIR: opts.agentDir,
    },
    cwd: opts.agentDir,
  });
}

describe('planmode hook, agent without Telegram credentials', () => {
  let root: string;
  let agentDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'planmode-'));
    agentDir = join(root, 'agent');
    mkdirSync(agentDir, { recursive: true }); // no .env: this is the tokenless case
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const journal = () => {
    const p = join(root, 'logs', 'a1', 'outbound-deliveries.jsonl');
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  };

  it('still auto-approves, and now records the approval nobody saw', () => {
    const res = runHook({ ctxRoot: root, agentDir, planFile: '/plans/ship-it.md' });

    // Behaviour must be unchanged -- this change is logging only.
    expect(res.stdout).toContain('"behavior":"allow"');

    const rows = journal();
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('hook:planmode');
    // dead-letter, because nothing was sent and nothing may be retried.
    expect(rows[0].state).toBe('dead-letter');
    expect(rows[0].attempts).toBe(0);
    // The audit value is naming WHICH plan sailed through unreviewed.
    expect(rows[0].preview).toContain('/plans/ship-it.md');
    expect(rows[0].error).toContain('no telegram credentials');
  });

  it('names the gap when the tool did not supply a plan file', () => {
    // Without this the record would say which plan was approved by saying
    // nothing at all, and a reader would take the blank as "no plan".
    runHook({ ctxRoot: root, agentDir });
    expect(journal()[0].preview).toContain('not supplied');
  });
});
