import { configDefaults, defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // Matches the dashboard's tsconfig path alias so tests under
      // dashboard/src/**/__tests__ can import dashboard source via "@/…".
      '@': path.resolve(__dirname, 'dashboard/src'),
      // Dashboard tests need to resolve `next/server` and other Next deps
      // from dashboard/node_modules, because root's package.json does not
      // depend on Next.js.
      'next/server': path.resolve(__dirname, 'dashboard/node_modules/next/server.js'),
    },
  },
  test: {
    globals: true,
    testTimeout: 10000,
    include: [
      'tests/**/*.test.ts',
      'dashboard/src/**/__tests__/**/*.test.ts',
    ],
    // task_1786592962516_42324247: these 9 files flake under vitest's default
    // parallel-worker pool (PID/lock timing + fake-timer cron-scheduler
    // simulations contending across workers), confirmed via an isolation
    // ladder -- they went from 10 files/13 tests failed to 4 files/1 failed
    // when rerun with --no-file-parallelism, with RAM flat throughout (not a
    // memory-pressure issue). A separate, still-flaky set (phase4-dashboard-
    // backtest, phase4-performance, phase5-user-journeys, phase5-e2e-simulation)
    // did NOT clear under --no-file-parallelism -- different root cause
    // (vi.resetModules() + dynamic Next.js route import), intentionally left
    // out of this list, filed separately.
    projects: [
      {
        extends: true,
        test: {
          name: 'sequential',
          include: [
            'tests/unit/utils/process-ownership.test.ts',
            'tests/unit/utils/lock.test.ts',
            'tests/unit/cli/status-ownership.test.ts',
            'tests/unit/cli/restart-command.test.ts',
            'tests/integration/phase2-backtesting.test.ts',
            'tests/integration/phase5-performance.test.ts',
            'tests/integration/phase5-failure-modes.test.ts',
            'tests/integration/multi-agent-crons.test.ts',
            'tests/integration/concurrent-cron-mutations.test.ts',
          ],
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'parallel',
          exclude: [
            ...configDefaults.exclude,
            'tests/unit/utils/process-ownership.test.ts',
            'tests/unit/utils/lock.test.ts',
            'tests/unit/cli/status-ownership.test.ts',
            'tests/unit/cli/restart-command.test.ts',
            'tests/integration/phase2-backtesting.test.ts',
            'tests/integration/phase5-performance.test.ts',
            'tests/integration/phase5-failure-modes.test.ts',
            'tests/integration/multi-agent-crons.test.ts',
            'tests/integration/concurrent-cron-mutations.test.ts',
          ],
        },
      },
    ],
  },
});
