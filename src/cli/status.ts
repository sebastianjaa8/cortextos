import { Command } from 'commander';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { basename, join } from 'path';
import { homedir } from 'os';
import { IPCClient } from '../daemon/ipc-server.js';
import type { AgentStatus, Heartbeat } from '../types/index.js';
import { inspectProcessIdentity, processIdentityMatches } from '../utils/process-ownership.js';
import type { RuntimeProcessRecord } from '../utils/process-ownership.js';

export interface RuntimeOwnershipDiagnostic {
  agent: string;
  pid?: number;
  status: 'owned' | 'orphan' | 'stale' | 'invalid';
  detail: string;
}

function parseRuntimeRecord(path: string): RuntimeProcessRecord | null {
  try {
    const record = JSON.parse(readFileSync(path, 'utf-8')) as Partial<RuntimeProcessRecord>;
    return record.version === 1 && typeof record.ownerToken === 'string' && /^[a-f0-9]{64}$/.test(record.ownerToken) &&
      typeof record.instanceId === 'string' && typeof record.agentName === 'string' &&
      typeof record.runtime === 'string' && Number.isSafeInteger(record.pid) && (record.pid ?? 0) > 0 &&
      typeof record.processStartIdentity === 'string' && typeof record.executablePath === 'string' &&
      Number.isSafeInteger(record.daemonPid) && (record.daemonPid ?? 0) > 0 &&
      typeof record.daemonStartIdentity === 'string' && typeof record.createdAt === 'string' &&
      !Number.isNaN(Date.parse(record.createdAt)) ? record as RuntimeProcessRecord : null;
  } catch {
    return null;
  }
}

export function inspectRuntimeOwnership(ctxRoot: string, instanceId: string): RuntimeOwnershipDiagnostic[] {
  const stateRoot = join(ctxRoot, 'state');
  if (!existsSync(stateRoot)) return [];
  let daemonPid: number | null = null;
  try {
    const parsed = Number(readFileSync(join(ctxRoot, 'daemon.pid'), 'utf-8').trim());
    if (Number.isSafeInteger(parsed) && parsed > 0) daemonPid = parsed;
  } catch { /* missing daemon is reported against each runtime record */ }
  const daemonIdentity = daemonPid === null ? null : inspectProcessIdentity(daemonPid);
  const results: RuntimeOwnershipDiagnostic[] = [];

  for (const entry of readdirSync(stateRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const agentDir = join(stateRoot, entry.name);
    const canonicalPaths: string[] = [];
    const direct = join(agentDir, 'agent-process.json');
    if (existsSync(direct)) canonicalPaths.push(direct);
    const recordsDir = join(agentDir, 'agent-processes');
    if (existsSync(recordsDir)) {
      for (const record of readdirSync(recordsDir, { withFileTypes: true })) {
        if (record.isFile() && record.name.endsWith('.json')) canonicalPaths.push(join(recordsDir, record.name));
      }
    }

    if (canonicalPaths.length === 0) {
      const legacy = readdirSync(agentDir, { withFileTypes: true }).find(record =>
        record.isFile() && /^(?!agent-).+-process\.json$/i.test(record.name));
      if (legacy) results.push({ agent: entry.name, status: 'invalid', detail: `legacy ownership record ${basename(legacy.name)}` });
      continue;
    }

    for (const recordPath of canonicalPaths) {
      const record = parseRuntimeRecord(recordPath);
      if (!record) {
        results.push({ agent: entry.name, status: 'invalid', detail: `invalid ${basename(recordPath)}` });
        continue;
      }
      const base = { agent: entry.name, pid: record.pid };
      if (record.instanceId !== instanceId || record.agentName !== entry.name) {
        results.push({ ...base, status: 'invalid', detail: 'record instance or agent identity mismatch' });
        continue;
      }
      const runtimeIdentity = inspectProcessIdentity(record.pid);
      if (!runtimeIdentity) {
        results.push({ ...base, status: 'stale', detail: 'recorded runtime process is not alive' });
        continue;
      }
      if (!processIdentityMatches(record, runtimeIdentity)) {
        results.push({ ...base, status: 'stale', detail: 'runtime PID identity does not match the record' });
        continue;
      }
      if (!daemonIdentity || record.daemonPid !== daemonPid || record.daemonStartIdentity !== daemonIdentity.startIdentity) {
        results.push({ ...base, status: 'orphan', detail: 'runtime is not owned by the current daemon identity' });
        continue;
      }
      results.push({ ...base, status: 'owned', detail: `owned ${record.runtime} runtime` });
    }
  }
  return results;
}
export const statusCommand = new Command('status')
  .option('--instance <id>', 'Instance ID')
  .option('--json', 'Output machine-readable live agent status')
  .option('--runtime-records-json', 'Output PID-reuse-safe runtime ownership diagnostics')
  .option('--telegram-delivery-health-json', 'Output Telegram delivery-journal health')
  .description('Show agent health and status')
  .action(async (options: { instance?: string; json?: boolean; runtimeRecordsJson?: boolean; telegramDeliveryHealthJson?: boolean }) => {
    const instanceId = options.instance || process.env.CTX_INSTANCE_ID || 'default';
    if (options.telegramDeliveryHealthJson) {
      const deliveryIpc = new IPCClient(instanceId);
      if (!(await deliveryIpc.isDaemonRunning())) {
        console.error('Daemon is not running; Telegram delivery health is unavailable.');
        process.exitCode = 1;
        return;
      }
      const response = await deliveryIpc.send({ type: 'telegram-delivery-health', source: 'cortextos status' });
      if (!response.success) {
        console.error(`Telegram delivery health failed: ${response.error}`);
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(response.data));
      return;
    }
    if (options.runtimeRecordsJson) {
      const ctxRoot = process.env.CTX_ROOT || join(homedir(), '.cortextos', instanceId);
      console.log(JSON.stringify(inspectRuntimeOwnership(ctxRoot, instanceId)));
      return;
    }
    const ipc = new IPCClient(instanceId);
    const daemonRunning = await ipc.isDaemonRunning();

    if (daemonRunning) {
      // Get live status from daemon
      const response = await ipc.send({ type: 'status', source: 'cortextos status' });
      if (response.success) {
        const statuses = response.data as AgentStatus[];
        if (options.json) console.log(JSON.stringify(statuses));
        else displayStatuses(statuses);
      }
    } else {
      if (options.json) {
        console.log('[]');
        process.exitCode = 1;
        return;
      }
      // Fall back to reading heartbeat files
      console.log('Daemon is not running. Showing last known heartbeats:\n');
      const ctxRoot = join(homedir(), '.cortextos', instanceId);
      const stateDir = join(ctxRoot, 'state');

      if (!existsSync(stateDir)) {
        console.log('  No heartbeat data found.');
        console.log('  Start with: cortextos start');
        return;
      }

      const agentDirs = readdirSync(stateDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

      if (agentDirs.length === 0) {
        console.log('  No agents have reported heartbeats.');
        return;
      }

      const rows: Array<{ agent: string; status: string; age: string; task: string }> = [];
      for (const agent of agentDirs) {
        const hbPath = join(stateDir, agent, 'heartbeat.json');
        try {
          const hb: Heartbeat = JSON.parse(readFileSync(hbPath, 'utf-8'));
          const ts = hb.last_heartbeat || hb.timestamp || new Date().toISOString();
          const age = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
          const ageStr = age < 60 ? `${age}s ago` : age < 3600 ? `${Math.floor(age / 60)}m ago` : `${Math.floor(age / 3600)}h ago`;
          rows.push({
            agent: hb.agent || agent,
            status: hb.status || 'unknown',
            age: ageStr,
            task: hb.current_task ? hb.current_task.substring(0, 30) : '-',
          });
        } catch {
          // Skip agents without heartbeat
        }
      }

      if (rows.length === 0) {
        console.log('  No agents have reported heartbeats.');
      } else {
        console.log('\n  Last Known Heartbeats\n');
        const header = '  Name              Status      Last Seen    Current Task';
        const separator = '  ' + '-'.repeat(header.length - 2);
        console.log(header);
        console.log(separator);
        for (const r of rows) {
          const name = r.agent.padEnd(18);
          const status = r.status.padEnd(12);
          const age = r.age.padEnd(13);
          console.log(`  ${name}${status}${age}${r.task}`);
        }
        console.log('');
      }
    }
  });

function displayStatuses(statuses: AgentStatus[]): void {
  if (statuses.length === 0) {
    console.log('No agents running.');
    console.log('Add one with: cortextos add-agent <name>');
    return;
  }

  console.log('\n  Agent Status\n');

  // Table header
  const header = '  Name              Status      PID       Uptime      Model';
  const separator = '  ' + '-'.repeat(header.length - 2);
  console.log(header);
  console.log(separator);

  for (const s of statuses) {
    const name = s.name.padEnd(18);
    const status = s.status.padEnd(12);
    const pid = (s.pid?.toString() || '-').padEnd(10);
    const uptime = s.uptime ? formatUptime(s.uptime).padEnd(12) : '-'.padEnd(12);
    const model = s.model || '-';
    console.log(`  ${name}${status}${pid}${uptime}${model}`);
  }

  for (const failure of statuses.filter(status => status.lastError)) {
    console.log(`  ! ${failure.name}: ${failure.lastError}`);
  }

  console.log('');
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}
