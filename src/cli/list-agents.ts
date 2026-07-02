import { Command } from 'commander';
import { homedir } from 'os';
import { join } from 'path';
import { listAgents } from '../bus/agents.js';
import { IPCClient } from '../daemon/ipc-server.js';

export const listAgentsCommand = new Command('list-agents')
  .description('List all agents in the system')
  .option('--org <org>', 'Filter by organization')
  .option('--format <format>', 'Output format: json or text', 'text')
  .option('--instance <id>', 'Instance ID')
  .action(async (options: { org?: string; format: string; instance?: string }) => {
    const instanceId = options.instance || process.env.CTX_INSTANCE_ID || 'default';
    const ctxRoot = join(homedir(), '.cortextos', instanceId);
    const agents = listAgents(ctxRoot, options.org);

    // listAgents() computes `running` from heartbeat freshness (<10 min),
    // which reads stale under load while the process is alive — the
    // 2026-07-02 false-alarm had operators restarting 5 healthy agents.
    // When the daemon is reachable, override with live registry truth and
    // mark heartbeat-stale-but-running agents explicitly. Heartbeat stays
    // as the fallback when the daemon is down.
    let daemonReachable = false;
    const liveRunning = new Set<string>();
    try {
      const ipc = new IPCClient(instanceId);
      const resp = await ipc.send({ type: 'status', source: 'cortextos list-agents' });
      if (resp.success && Array.isArray(resp.data)) {
        daemonReachable = true;
        for (const a of resp.data as Array<{ name: string; status: string }>) {
          if (a.status === 'running') liveRunning.add(a.name);
        }
      }
    } catch {
      // Daemon not running — heartbeat-based `running` is the best we have.
    }

    const merged = agents.map(a => {
      if (!daemonReachable) return { ...a, running_source: 'heartbeat' as const, heartbeat_stale: false };
      const live = liveRunning.has(a.name);
      return {
        ...a,
        heartbeat_stale: live && !a.running,
        running: live,
        running_source: 'daemon' as const,
      };
    });

    if (options.format === 'json') {
      console.log(JSON.stringify(merged, null, 2));
    } else {
      if (merged.length === 0) {
        console.log('No agents found.');
        return;
      }

      // Table header
      const header = '  Name              Display Name      Org              Role                          Status          Last Heartbeat';
      const separator = '  ' + '-'.repeat(header.length - 2);
      console.log('\n  Agents\n');
      console.log(header);
      console.log(separator);

      for (const a of merged) {
        const name = a.name.padEnd(18);
        const displayName = (a.display_name || '-').padEnd(18);
        const org = (a.org || '-').padEnd(17);
        const role = (a.role || '-').substring(0, 29).padEnd(30);
        // Show health indicator emoji
        const healthIcon = a.running ? '● ' : '○ ';
        const statusText = a.running ? (a.heartbeat_stale ? 'running*' : 'running') : 'stopped';
        const status = (healthIcon + statusText).padEnd(16);
        const hb = a.last_heartbeat || '-';
        console.log(`  ${name}${displayName}${org}${role}${status}${hb}`);
      }

      console.log(`\n  Total: ${merged.length} agents` + (daemonReachable ? '' : '  (daemon unreachable — status from heartbeat age)'));
      if (merged.some(a => a.heartbeat_stale)) {
        console.log('  * process alive (daemon registry) but heartbeat >10 min stale — catching up, not stuck\n');
      } else {
        console.log('');
      }
    }
  });
