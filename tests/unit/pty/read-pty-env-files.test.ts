import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readPtyEnvFiles } from '../../../src/pty/agent-pty.js';
import type { CtxEnv } from '../../../src/types/index.js';

describe('readPtyEnvFiles', () => {
  let root: string;
  let env: CtxEnv;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cortextos-ptyenv-'));
    const agentDir = join(root, 'orgs', 'acme', 'agents', 'hermes_local');
    mkdirSync(agentDir, { recursive: true });
    env = { projectRoot: root, org: 'acme', agentDir } as CtxEnv;
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('merges org secrets.env then agent .env, agent wins, blank values kept', () => {
    writeFileSync(join(root, 'orgs', 'acme', 'secrets.env'),
      '# org\nBOT_TOKEN=org-token\nINFISICAL_TOKEN=org-inf\nSHARED=1\n');
    writeFileSync(join(env.agentDir, '.env'),
      'BOT_TOKEN=\nHERMES_HOME=/profiles/fleet_local\n\nINFISICAL_TOKEN=\n');
    expect(readPtyEnvFiles(env)).toEqual({
      BOT_TOKEN: '',
      INFISICAL_TOKEN: '',
      SHARED: '1',
      HERMES_HOME: '/profiles/fleet_local',
    });
  });

  it('returns {} when neither file exists', () => {
    expect(readPtyEnvFiles(env)).toEqual({});
  });

  it('skips secrets.env when org or projectRoot is unset', () => {
    writeFileSync(join(root, 'orgs', 'acme', 'secrets.env'), 'HERMES_HOME=/org/level\n');
    expect(readPtyEnvFiles({ ...env, org: '' } as CtxEnv)).toEqual({});
  });
});
