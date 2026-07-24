import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import { createRequire } from 'module';
import {
  PM2_SUPERVISOR_POLICY,
  daemonAppName,
  dashboardAppName,
  dashboardPortForInstance,
  ecosystemCommand,
} from '../../../src/cli/ecosystem';
import {
  parsePm2ProcessList,
  pm2AppsAreOnline,
  pm2CanonicalError,
  pm2ExactOnlineOwnershipError,
  pm2NodeCliFromWrapper,
  pm2PreflightError,
} from '../../../src/cli/start';

const require = createRequire(import.meta.url);
const originalEnv = { ...process.env };
let tempRoots: string[] = [];

function loadConfig(path: string): { apps: Array<Record<string, any>> } {
  const resolved = require.resolve(path);
  delete require.cache[resolved];
  return require(resolved);
}

function expectExactPolicy(app: Record<string, any>, messageShutdown = false): void {
  expect(app).toMatchObject({
    kill_timeout: PM2_SUPERVISOR_POLICY.killTimeoutMs,
    listen_timeout: PM2_SUPERVISOR_POLICY.listenTimeoutMs,
    min_uptime: PM2_SUPERVISOR_POLICY.minUptimeMs,
    max_restarts: PM2_SUPERVISOR_POLICY.maxRestarts,
    exp_backoff_restart_delay: PM2_SUPERVISOR_POLICY.expBackoffRestartDelayMs,
    autorestart: true,
  });
  expect(app.shutdown_with_message).toBe(messageShutdown ? PM2_SUPERVISOR_POLICY.shutdownWithMessage : undefined);
  expect(app.wait_ready).toBe(messageShutdown ? PM2_SUPERVISOR_POLICY.waitReady : undefined);
  expect(app.filter_env).toEqual(PM2_SUPERVISOR_POLICY.filterEnv);
  expect(app.restart_delay).toBeUndefined();
}

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = { ...originalEnv };
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('PM2 supervisor policy', () => {
  it('uses unique per-instance names', () => {
    expect(daemonAppName('default')).toBe('cortextos-daemon-default');
    expect(daemonAppName('research')).toBe('cortextos-daemon-research');
    expect(dashboardAppName('research')).toBe('cortextos-dashboard-research');
    expect(dashboardPortForInstance('default')).toBe(3000);
    expect(dashboardPortForInstance('research')).not.toBe(dashboardPortForInstance('other'));
  });

  it('pins the checked-in ecosystem to the exact policy and canonical roots', () => {
    process.env.CTX_INSTANCE_ID = 'research';
    process.env.CTX_FRAMEWORK_ROOT = 'C:\\framework';
    process.env.CTX_PROJECT_ROOT = 'C:\\wrong-project';
    process.env.CTX_ROOT = 'C:\\runtime';
    process.env.PATH = 'C:\\bin';
    process.env.PATHEXT = '.COM;.EXE;.CMD;.BAT';
    const config = loadConfig(resolve('ecosystem.config.js'));
    const daemon = config.apps[0];

    expect(daemon.name).toBe('cortextos-daemon-research');
    expect(daemon.env).toMatchObject({
      CTX_INSTANCE_ID: 'research',
      CTX_ROOT: 'C:\\runtime',
      CTX_FRAMEWORK_ROOT: 'C:\\framework',
      CTX_PROJECT_ROOT: 'C:\\framework',
      PATH: 'C:\\bin',
      PATHEXT: '.COM;.EXE;.CMD;.BAT',
    });
    expect(PM2_SUPERVISOR_POLICY.filterEnv).not.toContain('PAT');
    expect(PM2_SUPERVISOR_POLICY.filterEnv).toEqual(expect.arrayContaining([
      'GITHUB_', 'TOKEN', 'API_KEY', 'ACCESS_KEY', 'PRIVATE_KEY', 'PASSWORD', 'CREDENTIAL',
    ]));
    expectExactPolicy(daemon, true);
  });

  it('emits the same exact policy from the generator', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cortextos-ecosystem-'));
    tempRoots.push(root);
    mkdirSync(join(root, 'dist'), { recursive: true });
    mkdirSync(join(root, 'orgs', 'acme', 'agents', 'analyst'), { recursive: true });
    mkdirSync(join(root, 'dashboard', 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(root, 'dashboard', 'package.json'), '{}');
    writeFileSync(join(root, 'dashboard', 'node_modules', '.bin', 'next'), '');
    process.env.CTX_FRAMEWORK_ROOT = root;
    process.env.CTX_INSTANCE_ID = 'research';
    const output = join(root, 'ecosystem.generated.cjs');

    await ecosystemCommand.parseAsync([
      'node', 'ecosystem', '--instance', 'research', '--org', 'acme', '--output', output,
    ]);

    expect(readFileSync(output, 'utf-8')).not.toMatch(/^\\s*restart_delay:/m);
    const config = loadConfig(output);
    const daemon = config.apps[0];
    expect(daemon.name).toBe('cortextos-daemon-research');
    expect(daemon.env.CTX_FRAMEWORK_ROOT).toBe(root);
    expect(daemon.env.CTX_PROJECT_ROOT).toBe(root);
    expectExactPolicy(daemon, true);
    const dashboard = config.apps[1];
    expect(dashboard.name).toBe('cortextos-dashboard-research');
    expect(dashboard.env.CTX_FRAMEWORK_ROOT).toBe(root);
    expect(dashboard.env.CTX_PROJECT_ROOT).toBe(root);
    expect(dashboard.env.PORT).toBe(String(dashboardPortForInstance('research')));
    expectExactPolicy(dashboard);
  });
});

describe('PM2 startup preflight', () => {
  it('parses only allowlisted fields with case-insensitive PM2 keys', () => {
    const summaries = parsePm2ProcessList(JSON.stringify([{
      NAME: 'cortextos-daemon-research',
      PID: 4242,
      PM2_ENV: {
        STATUS: 'online',
        ctx_instance_id: 'research',
        SECRET_TOKEN: 'must-not-escape',
      },
      OTHER_SECRET: 'must-not-escape',
    }]));

    expect(summaries).toEqual([{
      name: 'cortextos-daemon-research',
      instanceId: 'research',
      status: 'online',
      pid: 4242,
    }]);
    expect(JSON.stringify(summaries)).not.toContain('must-not-escape');
  });

  it('accepts one canonical app and rejects duplicates', () => {
    expect(pm2PreflightError([
      { name: 'cortextos-daemon-research', instanceId: 'research', status: 'online' },
    ], 'research')).toBeNull();

    expect(pm2PreflightError([
      { name: 'cortextos-daemon-research', instanceId: 'research' },
      { name: 'cortextos-daemon-research', instanceId: 'research' },
    ], 'research')).toContain('duplicate');
  });

  it('returns safe Cortex CLI guidance for legacy ownership', () => {
    const error = pm2PreflightError([
      { name: 'cortextos-daemon', instanceId: 'default', status: 'online' },
    ], 'default');
    expect(error).toContain('cortextos start --instance default');
    expect(error).not.toContain('pm2 save');
    expect(error).not.toContain('pm2 delete');
  });

  it('rejects legacy dashboards and cross-instance dashboard port collisions', () => {
    expect(pm2PreflightError([
      { name: 'cortextos-dashboard', instanceId: 'default', port: '3000' },
    ], 'default', '3000')).toContain('Legacy PM2 app');
    expect(pm2PreflightError([
      { name: 'cortextos-dashboard-other', instanceId: 'other', port: '4567' },
    ], 'research', '4567')).toContain('already owned');
  });

  it('requires canonical fields and online managed apps before save', () => {
    const root = resolve('C:/framework');
    const ctxRoot = resolve('C:/runtime');
    const processes = [{
      name: 'cortextos-daemon-research', instanceId: 'research', status: 'online',
      ctxRoot, frameworkRoot: root, projectRoot: root,
      scriptPath: join(root, 'dist', 'daemon.js'), cwd: root,
    }];
    expect(pm2AppsAreOnline(processes, 'research', false)).toBe(true);
    expect(pm2CanonicalError(processes, 'research', {
      ctxRoot, frameworkRoot: root, daemonScript: join(root, 'dist', 'daemon.js'), managesDashboard: false,
    })).toBeNull();
    expect(pm2CanonicalError([{ ...processes[0], cwd: resolve('C:/wrong') }], 'research', {
      ctxRoot, frameworkRoot: root, daemonScript: join(root, 'dist', 'daemon.js'), managesDashboard: false,
    })).toContain('cwd');
    expect(pm2ExactOnlineOwnershipError([{ ...processes[0], pid: 4242 }], 'research', {
      ctxRoot, frameworkRoot: root, daemonScript: join(root, 'dist', 'daemon.js'), managesDashboard: false,
    }, 4242)).toBeNull();
    expect(pm2ExactOnlineOwnershipError([{ ...processes[0], pid: 9999 }], 'research', {
      ctxRoot, frameworkRoot: root, daemonScript: join(root, 'dist', 'daemon.js'), managesDashboard: false,
    }, 4242)).toContain('does not match daemon.pid');
  });
});
describe('Windows supervisor scripts', () => {
  it('resolves the PM2 Node entrypoint without spawning the Windows cmd shim', () => {
    expect(pm2NodeCliFromWrapper('C:\\Users\\Sebas\\AppData\\Roaming\\npm\\pm2.cmd'))
      .toBe('C:\\Users\\Sebas\\AppData\\Roaming\\npm\\node_modules\\pm2\\bin\\pm2');
  });

  it('does not recommend the broken pm2-windows-startup package', () => {
    const startSource = readFileSync(resolve('src/cli/start.ts'), 'utf-8');
    const installSource = readFileSync(resolve('scripts/install-windows-pm2-startup.ps1'), 'utf-8');
    expect(startSource).not.toContain('npm install -g pm2-windows-startup');
    expect(installSource).not.toContain('npm install -g pm2-windows-startup');
    expect(installSource).toContain('Live and saved complete PM2 manifests differ');
    expect(installSource).toMatch(/\$liveNames = @\(\$live \| Where-Object Name -ne 'pm2-logrotate'/);
    expect(installSource).toMatch(/foreach \(\$liveApp in @\(\$live \| Where-Object Name -ne 'pm2-logrotate'\)\)/);
    expect(installSource).toContain('Test-ExistingStartupTask');
    expect(installSource).toContain('Existing scheduled task is canonical');
    expect(installSource).toContain("if ($App.Name -ne 'pm2-logrotate')");
    expect(installSource).not.toContain("Where-Object { $_.Name -match '^cortextos-(daemon|dashboard)");
  });

  it('pins health failures to a nonzero exit and never prints raw PM2 env', () => {
    const healthSource = readFileSync(resolve('scripts/cortextos-health.ps1'), 'utf-8');
    expect(healthSource).toContain('exit 1');
    expect(healthSource).toContain('ConvertFrom-Pm2JsonAllowlist');
    expect(healthSource).toContain('foreach ($entry in @($converted))');
    expect(healthSource).toMatch(/\$daemonAlive =[\s\S]*Enabled agent runtime status/);
    expect(healthSource).toContain('daemon fenced-lock validation failed');
    expect(healthSource).toContain('heartbeat token mismatch');
    expect(healthSource).toContain('is absent from the live daemon registry');
    expect(healthSource).toContain('Test-CanonicalPm2App');
    expect(healthSource).toContain('wait_ready');
    expect(healthSource).toContain('--telegram-delivery-health-json');
    expect(healthSource).toContain('Telegram delivery for');
    expect(healthSource).not.toContain('Write-Host $pm2Raw');
    expect(healthSource).not.toContain('Write-Output $pm2Raw');
  });
});
