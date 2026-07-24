import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { IPCClient } from '../daemon/ipc-server.js';
import { daemonAppName, resolveFrameworkRoot } from './ecosystem.js';
import { pm2PreflightError, readPm2Processes, runPm2 } from './start.js';
import { writeStopMarker } from './stop.js';
import { validateInstanceId } from '../utils/validate.js';
import {
  inspectProcessIdentity,
  probeProcessIdentity,
  processIdentityEquals,
  type ProcessIdentity,
} from '../utils/process-ownership.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export const DAEMON_STOP_TIMEOUT_MS = 75_000;

export function exactProcessGenerationIsGone(expected: ProcessIdentity): boolean {
  const probe = probeProcessIdentity(expected.pid);
  if (probe.status === 'unknown') return false;
  return probe.status === 'absent' || !processIdentityEquals(expected, probe.identity);
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await delay(250);
  }
  return false;
}

async function restartDaemon(instance: string): Promise<void> {
  validateInstanceId(instance);
  const projectRoot = resolveFrameworkRoot();
  const ecosystemPath = join(projectRoot, 'ecosystem.config.js');
  if (!existsSync(ecosystemPath)) throw new Error(`PM2 manifest missing: ${ecosystemPath}`);

  const ctxRoot = join(homedir(), '.cortextos', instance);
  const daemonPidPath = join(ctxRoot, 'daemon.pid');
  const appName = daemonAppName(instance);
  let org = '';
  const enabledPath = join(ctxRoot, 'config', 'enabled-agents.json');
  if (existsSync(enabledPath)) {
    try {
      const agents = JSON.parse(readFileSync(enabledPath, 'utf-8')) as Record<string, { org?: string }>;
      org = Object.values(agents).find(agent => agent.org)?.org ?? '';
    } catch {
      // Startup remains fail-closed in the daemon if the registry is invalid.
    }
  }
  const env = {
    ...process.env,
    CTX_INSTANCE_ID: instance,
    CTX_ROOT: ctxRoot,
    CTX_FRAMEWORK_ROOT: projectRoot,
    CTX_PROJECT_ROOT: projectRoot,
    ...(org ? { CTX_ORG: org } : {}),
  };
  const before = readPm2Processes(env);
  const preflightError = pm2PreflightError(before, instance);
  if (preflightError) throw new Error(preflightError);
  const app = before.find(entry => entry.name === appName);
  if (!app) throw new Error(`PM2 app ${appName} is not registered. Run: cortextos start --instance ${instance}`);
  if (app.status !== 'online') {
    throw new Error(`PM2 app ${appName} is ${app.status ?? 'unknown'}; refusing restart while supervisor state is not online`);
  }

  const oldPid = existsSync(daemonPidPath)
    ? Number.parseInt(readFileSync(daemonPidPath, 'utf-8').trim(), 10)
    : 0;
  const oldIdentity = inspectProcessIdentity(oldPid);
  if (!oldIdentity) {
    throw new Error(`Cannot prove the running daemon identity from ${daemonPidPath}; refusing an unsafe restart`);
  }
  console.log(`Stopping daemon safely: ${appName}`);
  runPm2(['stop', appName], projectRoot, env);
  const stopped = await waitUntil(async () => {
    const pm2Stopped = readPm2Processes(env).find(entry => entry.name === appName)?.status === 'stopped';
    const ipcStopped = !(await new IPCClient(instance).isDaemonRunning());
    const exactOldGenerationGone = exactProcessGenerationIsGone(oldIdentity);
    return pm2Stopped && ipcStopped && exactOldGenerationGone;
  }, DAEMON_STOP_TIMEOUT_MS);
  if (!stopped) {
    throw new Error(`Daemon ${oldPid || 'unknown'} did not fully stop; refusing to start a competing generation`);
  }

  // PM2 on Windows can deliver the old child's exit callback after stop
  // reports success. A quiet gap prevents that callback from corrupting the
  // next generation's supervisor record.
  await delay(2_000);
  runPm2(['delete', appName], projectRoot, env);
  console.log(`Starting daemon safely: ${appName}`);
  runPm2(['start', ecosystemPath, '--only', appName, '--update-env'], projectRoot, env);
  const ready = await waitUntil(async () => {
    const online = readPm2Processes(env).find(entry => entry.name === appName)?.status === 'online';
    return online && await new IPCClient(instance).isDaemonRunning();
  }, 90_000);
  if (!ready) throw new Error(`Daemon ${appName} did not become healthy after the safe restart`);
  runPm2(['save'], projectRoot, env);
  console.log(`Daemon restarted safely: ${appName}`);
}

export const restartCommand = new Command('restart')
  .argument('[agent]', 'Agent name to restart')
  .option('--instance <id>', 'Instance ID', 'default')
  .description('Restart an agent, or safely restart the daemon with --daemon. Direct PM2 restart is unsafe on Windows.')
  .option('--daemon', 'Safely restart the daemon with a stop-wait-start sequence')
  .action(async (agent: string | undefined, options: { instance: string; daemon?: boolean }) => {
    if (options.daemon) {
      if (agent) {
        console.error('Pass either an agent name or --daemon, not both.');
        process.exitCode = 1;
        return;
      }
      try {
        await restartDaemon(options.instance);
      } catch (err) {
        console.error(`Daemon restart refused: ${(err as Error).message}`);
        process.exitCode = 1;
      }
      return;
    }
    if (!agent) {
      console.error('Pass an agent name, or use --daemon for a safe daemon restart.');
      process.exitCode = 1;
      return;
    }
    const ipc = new IPCClient(options.instance);
    const daemonRunning = await ipc.isDaemonRunning();

    if (!daemonRunning) {
      console.error('Daemon is not running. Start it first: cortextos start');
      process.exit(1);
    }

    console.log(`Restarting agent: ${agent}`);

    // Stop phase mirrors `cortextos stop <agent>` — write the .user-stop marker
    // before the IPC stop so the SessionEnd crash-alert hook does not fire a
    // false 🚨 CRASH alarm during the brief stop window. (BUG-036 pattern.)
    writeStopMarker(options.instance, agent, 'stopped via cortextos restart');
    const stopResponse = await ipc.send({ type: 'stop-agent', agent, source: 'cortextos restart' });
    if (!stopResponse.success) {
      console.error(`  Stop failed: ${stopResponse.error}`);
      process.exit(1);
    }
    console.log(`  ${stopResponse.data}`);

    // Start phase — daemon's start-agent handler re-reads config.json + .env
    // and spawns a fresh PTY. Same code path as `cortextos start <agent>`
    // when the daemon is already running, so env reload / config re-read /
    // PTY respawn semantics match exactly.
    const startResponse = await ipc.send({ type: 'start-agent', agent, source: 'cortextos restart' });
    if (!startResponse.success) {
      console.error(`  Start failed: ${startResponse.error}`);
      console.error(`  Agent is now stopped. Recover with: cortextos start ${agent}`);
      process.exit(1);
    }
    console.log(`  ${startResponse.data}`);
  });
