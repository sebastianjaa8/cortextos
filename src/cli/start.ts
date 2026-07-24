import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join, normalize } from 'path';
import { homedir, platform } from 'os';
import { spawn, spawnSync } from 'child_process';
import { IPCClient } from '../daemon/ipc-server.js';
import { daemonAppName, dashboardAppName, dashboardPortForInstance, resolveFrameworkRoot } from './ecosystem.js';
import { validateInstanceId } from '../utils/validate.js';

const IS_WINDOWS = platform() === 'win32';
const PM2_COMMAND = IS_WINDOWS ? 'pm2.cmd' : 'pm2';
const SAFE_CMD = /^[@a-z0-9._/-]+$/i;

interface Pm2Invocation {
  command: string;
  args: string[];
}

function commandExists(cmd: string): boolean {
  if (!SAFE_CMD.test(cmd)) return false;
  const which = IS_WINDOWS ? 'where' : 'which';
  const result = spawnSync(which, [cmd], { stdio: 'pipe' });
  return result.status === 0;
}

export function pm2NodeCliFromWrapper(wrapperPath: string): string {
  return join(dirname(wrapperPath), 'node_modules', 'pm2', 'bin', 'pm2');
}

function resolvePm2Invocation(args: string[]): Pm2Invocation {
  if (!IS_WINDOWS) return { command: PM2_COMMAND, args };

  const located = spawnSync('where.exe', ['pm2.cmd'], {
    encoding: 'utf-8',
    windowsHide: true,
  });
  if (located.error || located.status !== 0) {
    throw new Error('pm2.cmd is not available on PATH');
  }

  for (const wrapperPath of located.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
    const nodeCli = pm2NodeCliFromWrapper(wrapperPath);
    if (existsSync(nodeCli)) {
      return { command: process.execPath, args: [nodeCli, ...args] };
    }
  }
  throw new Error('PM2 Node entrypoint could not be resolved from pm2.cmd');
}

function ciValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const entry = Object.entries(value).find(([name]) => name.toLowerCase() === key.toLowerCase());
  return entry?.[1];
}

function pm2Field(entry: unknown, key: string): unknown {
  return ciValue(entry, key) ?? ciValue(ciValue(entry, 'pm2_env'), key) ??
    ciValue(ciValue(ciValue(entry, 'pm2_env'), 'env'), key) ?? ciValue(ciValue(entry, 'env'), key);
}

export interface Pm2ProcessSummary {
  name: string;
  instanceId?: string;
  status?: string;
  ctxRoot?: string;
  frameworkRoot?: string;
  projectRoot?: string;
  scriptPath?: string;
  cwd?: string;
  port?: string;
  pid?: number;
}

export function parsePm2ProcessList(raw: string): Pm2ProcessSummary[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error('pm2 jlist did not return an array');
  return parsed.flatMap((entry): Pm2ProcessSummary[] => {
    const name = pm2Field(entry, 'name');
    if (typeof name !== 'string') return [];
    const summary: Pm2ProcessSummary = { name };
    const pid = pm2Field(entry, 'pid');
    if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0) summary.pid = pid;
    const fields: Array<[keyof Pm2ProcessSummary, string]> = [
      ['instanceId', 'CTX_INSTANCE_ID'], ['status', 'status'], ['ctxRoot', 'CTX_ROOT'],
      ['frameworkRoot', 'CTX_FRAMEWORK_ROOT'], ['projectRoot', 'CTX_PROJECT_ROOT'],
      ['scriptPath', 'pm_exec_path'], ['cwd', 'pm_cwd'], ['port', 'PORT'],
    ];
    for (const [target, source] of fields) {
      const value = pm2Field(entry, source);
      if (typeof value === 'string' || typeof value === 'number') Object.assign(summary, { [target]: String(value) });
    }
    return [summary];
  });
}

function samePath(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const a = normalize(left);
  const b = normalize(right);
  return IS_WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export interface ExpectedPm2Ownership {
  ctxRoot: string;
  frameworkRoot: string;
  daemonScript: string;
  managesDashboard: boolean;
  dashboardScript?: string;
  dashboardPort?: string;
}

export function pm2CanonicalError(
  processes: Pm2ProcessSummary[],
  instanceId: string,
  expected: ExpectedPm2Ownership,
): string | null {
  const daemon = processes.find(p => p.name === daemonAppName(instanceId));
  if (!daemon) return `PM2 did not create "${daemonAppName(instanceId)}"`;
  const daemonFields: Array<[string, boolean]> = [
    ['CTX_INSTANCE_ID', daemon.instanceId === instanceId],
    ['CTX_ROOT', samePath(daemon.ctxRoot, expected.ctxRoot)],
    ['CTX_FRAMEWORK_ROOT', samePath(daemon.frameworkRoot, expected.frameworkRoot)],
    ['CTX_PROJECT_ROOT', samePath(daemon.projectRoot, expected.frameworkRoot)],
    ['script', samePath(daemon.scriptPath, expected.daemonScript)],
    ['cwd', samePath(daemon.cwd, expected.frameworkRoot)],
  ];
  const daemonMismatch = daemonFields.find(([, matches]) => !matches)?.[0];
  if (daemonMismatch) return `${daemon.name} has non-canonical ${daemonMismatch}; refusing to save`;

  if (expected.managesDashboard) {
    const dashboard = processes.find(p => p.name === dashboardAppName(instanceId));
    if (!dashboard) return `PM2 did not create "${dashboardAppName(instanceId)}"`;
    const dashboardFields: Array<[string, boolean]> = [
      ['CTX_INSTANCE_ID', dashboard.instanceId === instanceId],
      ['CTX_ROOT', samePath(dashboard.ctxRoot, expected.ctxRoot)],
      ['CTX_FRAMEWORK_ROOT', samePath(dashboard.frameworkRoot, expected.frameworkRoot)],
      ['CTX_PROJECT_ROOT', samePath(dashboard.projectRoot, expected.frameworkRoot)],
      ['script', !!expected.dashboardScript && samePath(dashboard.scriptPath, expected.dashboardScript)],
      ['cwd', samePath(dashboard.cwd, join(expected.frameworkRoot, 'dashboard'))],
      ['PORT', dashboard.port === expected.dashboardPort],
    ];
    const dashboardMismatch = dashboardFields.find(([, matches]) => !matches)?.[0];
    if (dashboardMismatch) return `${dashboard.name} has non-canonical ${dashboardMismatch}; refusing to save`;
  }
  return null;
}

export function pm2PreflightError(
  processes: Pm2ProcessSummary[],
  instanceId: string,
  requestedDashboardPort?: string,
): string | null {
  const expectedName = daemonAppName(instanceId);
  const expectedDashboard = dashboardAppName(instanceId);
  const cortextApps = processes.filter(p => /^cortextos-(daemon|dashboard)(?:-|$)/i.test(p.name));
  const nameCounts = new Map<string, number>();
  for (const process of cortextApps) {
    const key = process.name.toLowerCase();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  const duplicateName = [...nameCounts.entries()].find(([, count]) => count > 1)?.[0];
  if (duplicateName) return `PM2 has duplicate app entries named "${duplicateName}". Delete that PM2 entry, then rerun \`cortextos start --instance ${instanceId}\`.`;

  for (const kind of ['daemon', 'dashboard'] as const) {
    const legacyName = `cortextos-${kind}`;
    const legacy = processes.filter(p => p.name.toLowerCase() === legacyName &&
      (p.instanceId === instanceId || (!p.instanceId && instanceId === 'default')));
    if (legacy.length) return `Legacy PM2 app "${legacyName}" owns instance "${instanceId}". Delete it, then rerun \`cortextos start --instance ${instanceId}\`.`;
  }

  const sameInstanceApps = processes.filter(p => p.instanceId === instanceId && /^cortextos-(daemon|dashboard)(?:-|$)/i.test(p.name));
  const unexpected = sameInstanceApps.find(p => p.name !== expectedName && p.name !== expectedDashboard);
  if (unexpected) return `PM2 app "${unexpected.name}" already owns instance "${instanceId}"; refusing to create canonical apps.`;

  if (requestedDashboardPort) {
    const collision = processes.find(p => /^cortextos-dashboard(?:-|$)/i.test(p.name) &&
      p.name !== expectedDashboard && p.port === requestedDashboardPort);
    if (collision) return `Dashboard port ${requestedDashboardPort} is already owned by "${collision.name}".`;
  }
  return null;
}

export function pm2AppsAreOnline(
  processes: Pm2ProcessSummary[], instanceId: string, managesDashboard: boolean,
): boolean {
  const daemon = processes.filter(p => p.name === daemonAppName(instanceId));
  if (daemon.length !== 1 || daemon[0].status !== 'online') return false;
  if (!managesDashboard) return true;
  const dashboard = processes.filter(p => p.name === dashboardAppName(instanceId));
  return dashboard.length === 1 && dashboard[0].status === 'online';
}

export function pm2ExactOnlineOwnershipError(
  processes: Pm2ProcessSummary[],
  instanceId: string,
  expected: ExpectedPm2Ownership,
  daemonPid: number,
): string | null {
  const preflight = pm2PreflightError(processes, instanceId, expected.managesDashboard ? expected.dashboardPort : undefined);
  if (preflight) return preflight;
  if (!pm2AppsAreOnline(processes, instanceId, expected.managesDashboard)) {
    return `Canonical PM2 apps for instance "${instanceId}" are not exactly online`;
  }
  const canonical = pm2CanonicalError(processes, instanceId, expected);
  if (canonical) return canonical;
  const daemon = processes.find(process => process.name === daemonAppName(instanceId));
  if (!Number.isSafeInteger(daemonPid) || daemonPid <= 0 || daemon?.pid !== daemonPid) {
    return `${daemonAppName(instanceId)} PM2 PID does not match daemon.pid`;
  }
  return null;
}

function expectedPm2Ownership(
  projectRoot: string,
  ctxRoot: string,
  instanceId: string,
  ecosystemPath: string,
): ExpectedPm2Ownership {
  const ecosystemSource = readFileSync(ecosystemPath, 'utf-8');
  const managesDashboard = ecosystemSource.includes("name: 'cortextos-dashboard-'");
  const dashboardPort = String(process.env.CTX_DASHBOARD_PORT || dashboardPortForInstance(instanceId));
  const dashboardScript = IS_WINDOWS
    ? join(projectRoot, 'dashboard', 'node_modules', 'next', 'dist', 'bin', 'next')
    : (() => {
        const located = spawnSync('which', ['npm'], { encoding: 'utf-8' });
        return located.status === 0 ? located.stdout.trim() : undefined;
      })();
  return {
    ctxRoot,
    frameworkRoot: projectRoot,
    daemonScript: join(projectRoot, 'dist', 'daemon.js'),
    managesDashboard,
    dashboardScript,
    dashboardPort,
  };
}
export function readPm2Processes(env: NodeJS.ProcessEnv): Pm2ProcessSummary[] {
  const invocation = resolvePm2Invocation(['jlist']);
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: 'utf-8',
    windowsHide: true,
    env,
  });
  if (result.error || result.status !== 0) {
    throw new Error('pm2 jlist failed; supervisor state could not be checked safely');
  }
  return parsePm2ProcessList(result.stdout || '[]');
}

export function runPm2(args: string[], cwd: string, env: NodeJS.ProcessEnv): void {
  const invocation = resolvePm2Invocation(args);
  const result = spawnSync(invocation.command, invocation.args, {
    stdio: 'inherit',
    cwd,
    env,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`pm2 ${args[0]} failed`);
  }
}

async function waitForSupervisorReady(
  env: NodeJS.ProcessEnv,
  instanceId: string,
  managesDashboard: boolean,
  ipc: IPCClient,
  timeoutMs = 30_000,
): Promise<Pm2ProcessSummary[]> {
  const deadline = Date.now() + timeoutMs;
  let latest: Pm2ProcessSummary[] = [];
  while (Date.now() < deadline) {
    latest = readPm2Processes(env);
    if (pm2AppsAreOnline(latest, instanceId, managesDashboard) && await ipc.isDaemonRunning()) return latest;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`PM2 apps did not become online with daemon IPC ready within ${timeoutMs / 1000}s`);
}

function printWindowsStartupInstructions(projectRoot: string): void {
  if (!IS_WINDOWS) return;
  console.log('\nFor auto-start at Windows logon:');
  console.log(`  powershell -ExecutionPolicy Bypass -File "${join(projectRoot, 'scripts', 'install-windows-pm2-startup.ps1')}"`);
}

export const startCommand = new Command('start')
  .argument('[agent]', 'Specific agent to start (starts all if omitted)')
  .option('--instance <id>', 'Instance ID', 'default')
  .option('--foreground', 'Run daemon in foreground (no PM2, for debugging)')
  .description('Start the cortextOS daemon and agents')
  .action(async (agent: string | undefined, options: { instance: string; foreground?: boolean }) => {
    validateInstanceId(options.instance);
    const ipc = new IPCClient(options.instance);
    const daemonRunning = await ipc.isDaemonRunning();

    if (daemonRunning && !agent) {
      try {
        if (!commandExists('pm2')) throw new Error('PM2 is unavailable; cannot prove supervisor ownership');
        const projectRoot = resolveFrameworkRoot();
        const ecosystemPath = join(projectRoot, 'ecosystem.config.js');
        if (!existsSync(ecosystemPath)) throw new Error(`PM2 manifest missing: ${ecosystemPath}`);
        const ctxRoot = join(homedir(), '.cortextos', options.instance);
        const ownership = expectedPm2Ownership(projectRoot, ctxRoot, options.instance, ecosystemPath);
        const supervisorEnv: NodeJS.ProcessEnv = {
          ...process.env,
          CTX_INSTANCE_ID: options.instance,
          CTX_ROOT: ctxRoot,
          CTX_FRAMEWORK_ROOT: projectRoot,
          CTX_PROJECT_ROOT: projectRoot,
          ...(ownership.managesDashboard ? { CTX_DASHBOARD_PORT: ownership.dashboardPort } : {}),
        };
        const daemonPid = Number.parseInt(readFileSync(join(ctxRoot, 'daemon.pid'), 'utf-8').trim(), 10);
        const ownershipError = pm2ExactOnlineOwnershipError(
          readPm2Processes(supervisorEnv), options.instance, ownership, daemonPid,
        );
        if (ownershipError) throw new Error(ownershipError);
      } catch (err) {
        console.error(`Supervisor ownership check failed: ${(err as Error).message}`);
        console.error('Refusing to report start success until the exact canonical PM2 daemon owns this instance.');
        process.exitCode = 1;
        return;
      }
    }

    if (!daemonRunning) {
      const projectRoot = resolveFrameworkRoot();
      const daemonScript = join(projectRoot, 'dist', 'daemon.js');

      if (!existsSync(daemonScript)) {
        console.error(`Daemon not built at ${daemonScript}. Run: npm run build`);
        process.exitCode = 1;
        return;
      }

      const ctxRoot = join(homedir(), '.cortextos', options.instance);
      let org = '';
      const enabledPath = join(ctxRoot, 'config', 'enabled-agents.json');
      if (existsSync(enabledPath)) {
        try {
          const agents = JSON.parse(readFileSync(enabledPath, 'utf-8'));
          const first = Object.values(agents as Record<string, any>)[0] as any;
          if (first?.org) org = first.org;
        } catch { /* ignore */ }
      }

      const daemonEnv: NodeJS.ProcessEnv = {
        ...process.env,
        CTX_INSTANCE_ID: options.instance,
        CTX_ROOT: ctxRoot,
        CTX_FRAMEWORK_ROOT: projectRoot,
        CTX_PROJECT_ROOT: projectRoot,
        ...(org ? { CTX_ORG: org } : {}),
      };

      if (options.foreground) {
        console.log('Starting cortextOS daemon in foreground...');
        console.log('(Press Ctrl+C to stop)\n');
        const child = spawn(process.execPath, [daemonScript, '--instance', options.instance], {
          stdio: 'inherit',
          env: daemonEnv,
          cwd: projectRoot,
        });
        child.on('exit', (code) => process.exit(code || 0));
        process.on('SIGINT', () => child.kill('SIGTERM'));
        process.on('SIGTERM', () => child.kill('SIGTERM'));
        process.on('exit', () => { try { child.kill(); } catch { /* already dead */ } });
        return;
      }

      if (commandExists('pm2')) {
        const ecosystemPath = join(projectRoot, 'ecosystem.config.js');
        try {
          if (!existsSync(ecosystemPath)) {
            console.log('Generating ecosystem.config.js...');
            const generate = spawnSync(process.execPath, [
              join(projectRoot, 'dist', 'cli.js'),
              'ecosystem',
              '--instance', options.instance,
            ], { stdio: 'inherit', cwd: projectRoot, env: daemonEnv, windowsHide: true });
            if (generate.error || generate.status !== 0 || !existsSync(ecosystemPath)) {
              throw new Error('ecosystem generation failed');
            }
          }

          const ecosystemSource = readFileSync(ecosystemPath, 'utf-8');
          const managesDashboard = ecosystemSource.includes("name: 'cortextos-dashboard-'");
          const dashboardPort = String(process.env.CTX_DASHBOARD_PORT || dashboardPortForInstance(options.instance));
          if (managesDashboard) daemonEnv.CTX_DASHBOARD_PORT = dashboardPort;
          const dashboardScript = IS_WINDOWS
            ? join(projectRoot, 'dashboard', 'node_modules', 'next', 'dist', 'bin', 'next')
            : (() => {
                const located = spawnSync('which', ['npm'], { encoding: 'utf-8' });
                return located.status === 0 ? located.stdout.trim() : undefined;
              })();
          const expectedOwnership: ExpectedPm2Ownership = {
            ctxRoot,
            frameworkRoot: projectRoot,
            daemonScript,
            managesDashboard,
            dashboardScript,
            dashboardPort,
          };

          const before = readPm2Processes(daemonEnv);
          const preflightError = pm2PreflightError(before, options.instance, managesDashboard ? dashboardPort : undefined);
          if (preflightError) throw new Error(preflightError);

          const expectedName = daemonAppName(options.instance);
          console.log(`Applying PM2 manifest for ${expectedName}...`);
          runPm2(['start', ecosystemPath, '--update-env'], projectRoot, daemonEnv);

          const ready = await waitForSupervisorReady(daemonEnv, options.instance, managesDashboard, ipc);
          const postflightError = pm2PreflightError(ready, options.instance, managesDashboard ? dashboardPort : undefined);
          if (postflightError) throw new Error(postflightError);
          const canonicalError = pm2CanonicalError(ready, options.instance, expectedOwnership);
          if (canonicalError) throw new Error(canonicalError);

          runPm2(['save'], projectRoot, daemonEnv);
          console.log('\nDaemon started. Use `cortextos status` to check agents.');
          printWindowsStartupInstructions(projectRoot);
        } catch (err) {
          console.error(`PM2 start refused: ${(err as Error).message}`);
          console.error(`Inspect with: powershell -ExecutionPolicy Bypass -File "${join(projectRoot, 'scripts', 'cortextos-health.ps1')}" -Instance ${options.instance}`);
          process.exitCode = 1;
        }
      } else {
        console.log('PM2 not found. Starting daemon directly (background)...');
        console.log('(Install PM2 for persistence across reboots: npm install -g pm2)\n');

        const logFile = join(ctxRoot, 'logs', 'daemon.log');
        const MAX_SPAWN_ATTEMPTS = 3;
        const SPAWN_RETRY_BACKOFF_MS = 2000;
        const ipc2 = new IPCClient(options.instance);
        let running = false;

        for (let attempt = 1; attempt <= MAX_SPAWN_ATTEMPTS && !running; attempt++) {
          const child = spawn(process.execPath, [daemonScript, '--instance', options.instance], {
            detached: true,
            stdio: ['ignore', 'ignore', 'ignore'],
            env: daemonEnv,
            cwd: projectRoot,
            windowsHide: true,
          });
          child.unref();
          await new Promise(r => setTimeout(r, 1500));
          running = await ipc2.isDaemonRunning();
          if (!running && attempt < MAX_SPAWN_ATTEMPTS) {
            console.log(`Daemon spawn attempt ${attempt}/${MAX_SPAWN_ATTEMPTS} did not produce a running daemon. Retrying in ${SPAWN_RETRY_BACKOFF_MS / 1000}s...`);
            await new Promise(r => setTimeout(r, SPAWN_RETRY_BACKOFF_MS));
          }
        }

        if (running) {
          console.log('Daemon started successfully (background process).');
          console.log('Install PM2 for persistence: npm install -g pm2');
        } else {
          console.error(`Daemon failed to start after ${MAX_SPAWN_ATTEMPTS} attempts.`);
          console.error(`Check the daemon log: ${logFile}`);
          process.exitCode = 1;
        }
      }
      return;
    }

    if (agent) {
      const ctxRoot = join(homedir(), '.cortextos', options.instance);
      const enabledPath = join(ctxRoot, 'config', 'enabled-agents.json');
      let enabledAgents: Record<string, any> = {};
      try {
        if (existsSync(enabledPath)) enabledAgents = JSON.parse(readFileSync(enabledPath, 'utf-8'));
      } catch { /* ignore */ }

      if (!enabledAgents[agent]) {
        const existingOrg = Object.values(enabledAgents as Record<string, any>).find((e: any) => e.org)?.org;
        enabledAgents[agent] = {
          enabled: true,
          status: 'configured',
          ...(existingOrg ? { org: existingOrg } : {}),
        };
        mkdirSync(join(ctxRoot, 'config'), { recursive: true });
        writeFileSync(enabledPath, JSON.stringify(enabledAgents, null, 2) + '\n', 'utf-8');
        console.log(`  Registered ${agent} in enabled-agents.json`);
      }

      console.log(`Starting agent: ${agent}`);
      const response = await ipc.send({ type: 'start-agent', agent, source: 'cortextos start' });
      if (response.success) console.log(`  ${response.data}`);
      else console.error(`  Error: ${response.error}`);
    } else {
      const response = await ipc.send({ type: 'start-all-agents', source: 'cortextos start' });
      if (response.success) {
        const statuses = response.data as any[];
        if (statuses.length === 0) {
          console.log('No agents configured. Add one with: cortextos add-agent <name>');
        } else {
          console.log('Enabled agent statuses:');
          for (const s of statuses) console.log(`  ${s.name}: ${s.status} (pid: ${s.pid || '-'})`);
        }
      }
    }
  });
